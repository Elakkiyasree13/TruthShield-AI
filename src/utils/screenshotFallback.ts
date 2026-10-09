import { AnalysisResult, Claim } from '../types';
import { analyzeContentLocally } from './analyzer';

const UNVERIFIED_EXPLANATION =
  'AI fact-checking was unavailable, so this claim was not verified. This does not mean the claim is true or false.';

export function createUnverifiedScreenshotResult(rawText: string): AnalysisResult {
  const cleanText = rawText.trim();
  const sentences = cleanText
    .split(/[.!?\n]+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .slice(0, 4);
  const claims: Claim[] = (sentences.length ? sentences : [
    'No readable text was extracted from the screenshot.',
  ]).map((text, index) => ({
    id: `unverified-claim-${index + 1}`,
    text,
    verdict: 'UNVERIFIED',
    confidence: 0,
    explanation: UNVERIFIED_EXPLANATION,
    sources: [],
  }));

  const result = analyzeContentLocally('Screenshot analysis is unavailable.', 'screenshot');
  return {
    ...result,
    id: `unverified-screenshot-${Date.now()}`,
    rawText: cleanText || 'Uploaded screenshot',
    title: 'Screenshot analysis',
    overallRisk: 'UNVERIFIED RISK',
    riskScore: 0,
    confidenceScore: 0,
    summary: 'AI fact-checking is currently unavailable. The extracted text below has not been fact-checked.',
    verificationNote: 'AI verification could not be completed. All extracted text is marked unverified; no conclusion is being made about whether the claims are true or false.',
    metrics: {
      truthfulness: 0,
      evidenceStrength: 0,
      manipulationRisk: 0,
      sourceReliability: 0,
    },
    claims,
    tactics: [],
    eli15Explanation: 'The app could read text from this image, but its fact-checking service did not respond. These claims have not been checked, so do not treat this result as proof either way.',
    translations: {
      en: {
        verdictLabel: 'Unverified — AI check unavailable',
        summary: 'The image text was extracted, but could not be checked against reliable evidence.',
        eli15: 'The text was read, but the fact-checking service did not respond. We cannot say if it is true or false.',
        actionTip: 'Try again later or check the claim with a trusted source before sharing.',
      },
      ta: {
        verdictLabel: 'சரிபார்க்கப்படவில்லை — AI சேவை கிடைக்கவில்லை',
        summary: 'படத்திலிருந்து உரை எடுக்கப்பட்டது; நம்பகமான ஆதாரங்களுடன் சரிபார்க்க முடியவில்லை.',
        eli15: 'உரையைப் படித்தோம், ஆனால் உண்மைச் சரிபார்ப்பு சேவை பதிலளிக்கவில்லை. இது உண்மையா பொய்யா என்று கூற முடியாது.',
        actionTip: 'பிறகு மீண்டும் முயற்சிக்கவும் அல்லது பகிர்வதற்கு முன் நம்பகமான ஆதாரத்தில் சரிபார்க்கவும்.',
      },
      hi: {
        verdictLabel: 'असत्यापित — AI जांच उपलब्ध नहीं',
        summary: 'चित्र से पाठ निकाला गया, लेकिन विश्वसनीय स्रोतों से उसकी जांच नहीं हो सकी।',
        eli15: 'पाठ पढ़ लिया गया, लेकिन तथ्य-जांच सेवा ने जवाब नहीं दिया। हम नहीं कह सकते कि यह सही है या गलत।',
        actionTip: 'बाद में फिर कोशिश करें या साझा करने से पहले किसी विश्वसनीय स्रोत से जांचें।',
      },
      ml: {
        verdictLabel: 'സ്ഥിരീകരിച്ചിട്ടില്ല — AI പരിശോധന ലഭ്യമല്ല',
        summary: 'ചിത്രത്തിൽ നിന്ന് എഴുത്ത് ലഭിച്ചു, എന്നാൽ വിശ്വസനീയമായ ഉറവിടങ്ങളുമായി പരിശോധിക്കാനായില്ല.',
        eli15: 'എഴുത്ത് വായിച്ചു, പക്ഷേ വസ്തുതാ പരിശോധനാ സേവനം പ്രതികരിച്ചില്ല. ഇത് ശരിയാണോ തെറ്റാണോ എന്ന് പറയാനാവില്ല.',
        actionTip: 'പിന്നീട് വീണ്ടും ശ്രമിക്കുക, അല്ലെങ്കിൽ പങ്കിടുന്നതിന് മുമ്പ് വിശ്വസനീയമായ ഉറവിടത്തിൽ പരിശോധിക്കുക.',
      },
    },
    imageAnalysis: {
      isAiGeneratedEstimate: 'Unable to determine',
      confidence: 0,
      signals: ['AI image analysis was unavailable; no authenticity conclusion was made.'],
      reverseSearchQuery: cleanText.slice(0, 60),
      disclaimer: 'This fallback does not assess whether the image is original, edited, or AI-generated.',
    },
    timestamp: new Date().toISOString(),
  };
}
