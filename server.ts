import express, { Request, Response as ExpressResponse } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { analyzeContentLocally } from './src/utils/analyzer.ts';
import { normalizeAssessmentRisk } from './src/utils/riskAssessment.ts';
import { createUnverifiedScreenshotResult } from './src/utils/screenshotFallback.ts';
import { COMMUNITY_TRENDS } from './src/data/trendData.ts';

dotenv.config({ path: ['.env', 'key.env'] });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'] as const;

app.use(express.json({ limit: '12mb' }));

const MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_TEXT_LENGTH = 12_000;

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const value = octets.reduce((result, octet) => result * 256 + octet, 0);
    const blockedRanges: Array<[number, number]> = [
      [0x00000000, 0x00ffffff],
      [0x0a000000, 0x0affffff],
      [0x64400000, 0x647fffff],
      [0x7f000000, 0x7fffffff],
      [0xa9fe0000, 0xa9feffff],
      [0xac100000, 0xac1fffff],
      [0xc0000000, 0xc00000ff],
      [0xc0000200, 0xc00002ff],
      [0xc0a80000, 0xc0a8ffff],
      [0xc6120000, 0xc613ffff],
      [0xc6336400, 0xc63364ff],
      [0xcb007100, 0xcb0071ff],
      [0xe0000000, 0xffffffff],
    ];
    return !blockedRanges.some(([start, end]) => value >= start && value <= end);
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:');
  }

  return false;
}

function getApiErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

async function validatePublicUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid public webpage URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP or HTTPS webpage URLs are supported.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'example' || hostname.endsWith('.example')) {
    throw new Error('This URL uses the reserved .example domain, so it is not a live public webpage and cannot be fetched. Enter the real website URL to analyze its content.');
  }
  if (
    isIP(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test')
  ) {
    throw new Error('This is a localhost, test, or private-network URL and cannot be fetched safely. Enter a public website URL instead.');
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('The webpage hostname could not be resolved.');
  }

  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('The URL must resolve only to public internet addresses.');
  }

  return url;
}

async function readPageBody(response: globalThis.Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (
    contentType &&
    !contentType.includes('text/html') &&
    !contentType.includes('application/xhtml+xml') &&
    !contentType.includes('text/plain')
  ) {
    throw new Error('This URL does not serve readable webpage text.');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_PAGE_BYTES) {
    throw new Error('The webpage is too large to analyze.');
  }

  if (!response.body) {
    throw new Error('The webpage returned no readable content.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error('The webpage is too large to analyze.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function extractPageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH);
}

async function fetchPublicPage(value: string): Promise<{ url: URL; text: string }> {
  let currentUrl = value;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const validatedUrl = await validatePublicUrl(currentUrl);
    const response = await fetch(validatedUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'User-Agent': 'TruthShieldAI/1.0 (public webpage analysis)',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 5) {
        throw new Error('The webpage redirected too many times.');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`The webpage returned HTTP ${response.status}.`);
    }

    const body = await readPageBody(response);
    const text = extractPageText(body);
    if (text.length < 40) {
      throw new Error('The webpage did not contain enough readable text to analyze.');
    }
    return { url: validatedUrl, text };
  }

  throw new Error('The webpage redirected too many times.');
}

// Health check endpoint
app.get('/api/health', (req: Request, res: ExpressResponse) => {
  res.json({ status: 'ok', service: 'TruthShield AI Engine', timestamp: new Date().toISOString() });
});

// Trend stats endpoint
app.get('/api/stats', (req: Request, res: ExpressResponse) => {
  res.json(COMMUNITY_TRENDS);
});

// Analyze content endpoint
app.post('/api/analyze', async (req: Request, res: ExpressResponse) => {
  const { text, sourceType = 'text', language = 'en', level = 'Detailed', url, imageData } = req.body;

  if (sourceType === 'url' && (typeof url !== 'string' || url.trim().length === 0)) {
    return res.status(400).json({ error: 'A webpage URL is required for URL analysis.' });
  }
  if (
    sourceType !== 'url' &&
    (!text || typeof text !== 'string' || text.trim().length === 0) &&
    !(sourceType === 'screenshot' && typeof imageData === 'string')
  ) {
    return res.status(400).json({ error: 'Text content is required for analysis.' });
  }

  let analysisText = typeof text === 'string' ? text.trim() : '';
  let imageMimeType: string | undefined;
  let imageBase64: string | undefined;
  if (sourceType === 'screenshot' && imageData !== undefined) {
    const imageMatch = typeof imageData === 'string'
      ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(imageData)
      : null;
    if (!imageMatch) {
      return res.status(400).json({ error: 'The uploaded image must be a valid PNG, JPG, or WEBP file.' });
    }
    imageMimeType = imageMatch[1];
    imageBase64 = imageMatch[2];
    if (Buffer.from(imageBase64, 'base64').byteLength > 8 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image size exceeds the 8MB limit.' });
    }
  }
  let rawText = analysisText;
  if (sourceType === 'url') {
    try {
      const page = await fetchPublicPage(url.trim());
      analysisText = page.text;
      rawText = page.url.toString();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to retrieve the webpage.';
      return res.status(422).json({ error: message });
    }
  }

  if (sourceType === 'screenshot' && !process.env.GEMINI_API_KEY) {
    return res.json(createUnverifiedScreenshotResult(analysisText));
  }

  // If GEMINI_API_KEY is available, use Gemini 3.8 Flash for deep extraction
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemPrompt = `You are TruthShield AI, an authoritative, unbiased, and educational misinformation detection system.
Given suspicious user content, extract individual factual claims and classify each as: 'TRUE', 'FALSE', 'MISLEADING', or 'UNVERIFIED'.
CRITICAL: Never classify claims as fake without evidence. If evidence is unavailable, classify as 'UNVERIFIED'. Serious subject matter, urgent events, or the presence of a manipulation phrase alone do not prove a news report or claim is false.
Assess misinformation risk from factual claim verdicts, not from whether an image looks original, edited, or AI-generated. If there are no FALSE or MISLEADING claims, set riskScore to 0 and overallRisk to LOW RISK when every claim is TRUE, or UNVERIFIED RISK when any claim is UNVERIFIED. Unverified means there is not enough evidence to decide; it is not evidence of misinformation. Only FALSE or MISLEADING claims should increase misinformation risk.
For screenshot analysis, also inspect the image itself for visible signs of AI generation or editing. Return imageAnalysis.isAiGeneratedEstimate as exactly one of: 'Likely AI-generated', 'Possibly edited', 'No obvious AI indicators', or 'Unable to determine'. This is only a visual estimate, not proof that an image is original or fake. If the image is tiny, blurry, compressed, or otherwise unclear, use 'Unable to determine' with confidence no higher than 25. 'No obvious AI indicators' is not proof the image is real and must have confidence no higher than 50. Use 'Possibly edited' confidence no higher than 65 and 'Likely AI-generated' no higher than 85. List only concrete visual signals and do not infer authenticity from the text claim alone.
Detect manipulation tactics (e.g. False Urgency, Fake Authority, Outrage Bait, Clickbait, Social Pressure, Fear Mongering, Conspiracy Framing, Misleading Statistics, Brand Impersonation).
Provide evidence sources, clear reasons, an 'Explain Like I'm 15' summary, translations in Tamil (ta), Hindi (hi), and Malayalam (ml), and a 'Misinformation Vaccine' educational module.`;

      const prompt = sourceType === 'url'
        ? `Analyze the extracted webpage text from ${rawText} for factual claims and manipulation. A URL or HTTPS connection alone does not prove a page is trustworthy. If evidence is unavailable, classify claims as UNVERIFIED rather than declaring the page true or fake.\nWebpage text:\n"${analysisText}"\nExplanation Level: ${level}\nUser requested language: ${language}`
        : sourceType === 'screenshot'
          ? imageBase64
            ? `Analyze the attached image directly. Extract and assess any factual claims, but do not treat OCR errors, sensational presentation, or serious subject matter as proof of misinformation. Separately inspect the image for visual evidence of AI generation or editing and populate imageAnalysis. Look for concrete inconsistencies such as malformed details, unnatural repeated textures, lighting or shadow conflicts, compositing edges, and inconsistent text rendering. If image resolution or quality is insufficient for visual inspection, use 'Unable to determine' and confidence at most 25. 'No obvious AI indicators' must have confidence at most 50 and must not be presented as proof of authenticity. Do not claim that an image is original based only on a lack of obvious artifacts. If there are no factual claims, return an empty claims array and still provide imageAnalysis. Use UNVERIFIED for claims you cannot check against reliable evidence.\nOptional transcription: "${analysisText || 'None provided'}"\nExplanation Level: ${level}\nUser requested language: ${language}`
            : `Analyze the following text extracted from a screenshot using OCR. Extract factual claims and assess them, distinguishing ordinary reputable news reporting from deceptive claims. The OCR may contain recognition errors; do not treat those as evidence of misinformation. Serious subject matter or urgent wording alone is not proof the content is fake. Classify claims as UNVERIFIED if you cannot verify them with reliable evidence.\nOCR text:\n"${analysisText}"\nExplanation Level: ${level}\nUser requested language: ${language}`
          : `Analyze this content:\n"${rawText}"\nExplanation Level: ${level}\nUser requested language: ${language}`;

      const request = {
        contents: imageBase64
          ? [
              { text: prompt },
              { inlineData: { mimeType: imageMimeType!, data: imageBase64 } },
            ]
          : prompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallRisk: {
                type: Type.STRING,
                description: "HIGH RISK, MODERATE RISK, LOW RISK, or UNVERIFIED RISK, based only on FALSE or MISLEADING claim verdicts",
              },
              riskScore: { type: Type.INTEGER },
              confidenceScore: { type: Type.INTEGER },
              summary: { type: Type.STRING },
              metrics: {
                type: Type.OBJECT,
                properties: {
                  truthfulness: { type: Type.INTEGER },
                  evidenceStrength: { type: Type.INTEGER },
                  manipulationRisk: { type: Type.INTEGER },
                  sourceReliability: { type: Type.INTEGER },
                },
              },
              claims: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    text: { type: Type.STRING },
                    verdict: { type: Type.STRING, description: "TRUE, FALSE, MISLEADING, or UNVERIFIED" },
                    confidence: { type: Type.INTEGER },
                    explanation: { type: Type.STRING },
                    sources: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          id: { type: Type.STRING },
                          title: { type: Type.STRING },
                          publisher: { type: Type.STRING },
                          type: { type: Type.STRING },
                          reliability: { type: Type.STRING },
                          date: { type: Type.STRING },
                          url: { type: Type.STRING },
                          stance: { type: Type.STRING },
                          quote: { type: Type.STRING },
                          isDemo: { type: Type.BOOLEAN },
                        },
                      },
                    },
                  },
                },
              },
              tactics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    category: { type: Type.STRING },
                    matchedText: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                    userTip: { type: Type.STRING },
                    color: { type: Type.STRING },
                  },
                },
              },
              eli15Explanation: { type: Type.STRING },
              translations: {
                type: Type.OBJECT,
                properties: {
                  en: {
                    type: Type.OBJECT,
                    properties: {
                      verdictLabel: { type: Type.STRING },
                      summary: { type: Type.STRING },
                      eli15: { type: Type.STRING },
                      actionTip: { type: Type.STRING },
                    },
                  },
                  ta: {
                    type: Type.OBJECT,
                    properties: {
                      verdictLabel: { type: Type.STRING },
                      summary: { type: Type.STRING },
                      eli15: { type: Type.STRING },
                      actionTip: { type: Type.STRING },
                    },
                  },
                  hi: {
                    type: Type.OBJECT,
                    properties: {
                      verdictLabel: { type: Type.STRING },
                      summary: { type: Type.STRING },
                      eli15: { type: Type.STRING },
                      actionTip: { type: Type.STRING },
                    },
                  },
                  ml: {
                    type: Type.OBJECT,
                    properties: {
                      verdictLabel: { type: Type.STRING },
                      summary: { type: Type.STRING },
                      eli15: { type: Type.STRING },
                      actionTip: { type: Type.STRING },
                    },
                  },
                },
              },
              vaccine: {
                type: Type.OBJECT,
                properties: {
                  tacticEncountered: { type: Type.STRING },
                  howTrickWorks: { type: Type.STRING },
                  howToProtect: { type: Type.STRING },
                  nextTimeExample: { type: Type.STRING },
                  microQuiz: {
                    type: Type.OBJECT,
                    properties: {
                      question: { type: Type.STRING },
                      options: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      correctIndex: { type: Type.INTEGER },
                      explanation: { type: Type.STRING },
                    },
                  },
                },
              },
              imageAnalysis: {
                type: Type.OBJECT,
                properties: {
                  isAiGeneratedEstimate: {
                    type: Type.STRING,
                    enum: ['Likely AI-generated', 'Possibly edited', 'No obvious AI indicators', 'Unable to determine'],
                  },
                  confidence: { type: Type.INTEGER },
                  signals: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  reverseSearchQuery: { type: Type.STRING },
                  disclaimer: { type: Type.STRING },
                },
              },
            },
          },
        },
      };
      let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;
      let lastModelError: unknown;
      for (const [modelIndex, model] of GEMINI_MODELS.entries()) {
        const maxAttempts = modelIndex === 0 ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          try {
            response = await ai.models.generateContent({ ...request, model });
            break;
          } catch (error) {
            lastModelError = error;
            const status = getApiErrorStatus(error);
            if (status === 429 || status === 404) {
              console.warn(`Gemini model ${model} is unavailable for this request (HTTP ${status}); trying the next configured model.`);
              break;
            }
            const canRetrySameModel = attempt < maxAttempts - 1
              && status !== undefined
              && [500, 502, 503, 504].includes(status);
            if (canRetrySameModel) {
              console.warn(`Gemini model ${model} returned HTTP ${status}; retrying once.`);
              await new Promise(resolve => setTimeout(resolve, 1_000));
              continue;
            }
            if (modelIndex < GEMINI_MODELS.length - 1 && [500, 502, 503, 504].includes(status ?? 0)) {
              console.warn(`Gemini model ${model} remains unavailable; trying ${GEMINI_MODELS[modelIndex + 1]}.`);
              break;
            }
            throw error;
          }
        }
        if (response) {
          break;
        }
      }
      if (!response) {
        throw lastModelError ?? new Error('Gemini did not return a response from any configured model.');
      }

      const parsedJson = JSON.parse(response.text || '{}');
      if (
        parsedJson
        && Array.isArray(parsedJson.claims)
        && (parsedJson.claims.length > 0 || (sourceType === 'screenshot' && parsedJson.imageAnalysis))
      ) {
        return res.json(normalizeAssessmentRisk({
          id: `gemini-analysis-${Date.now()}`,
          rawText: rawText || 'Uploaded screenshot',
          sourceType,
          timestamp: new Date().toISOString(),
          ...parsedJson,
        }));
      }
    } catch (aiError) {
      console.warn('Gemini API analysis failed:', aiError);
      if (sourceType === 'screenshot') {
        return res.json(createUnverifiedScreenshotResult(analysisText));
      }
    }
  }

  if (sourceType === 'screenshot') {
    return res.json(createUnverifiedScreenshotResult(analysisText));
  }

  // Resilient heuristic engine fallback
  const localResult = analyzeContentLocally(analysisText, sourceType);
  if (sourceType === 'url') {
    localResult.rawText = rawText;
    localResult.title = 'Webpage Content Analysis';
    localResult.summary = `Analysis of the fetched webpage at ${rawText}. ${localResult.summary}`;
  }
  return res.json(localResult);
});

// Mount Vite or serve static assets
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: ExpressResponse) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TruthShield AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
