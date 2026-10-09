import {
  AnalysisResult,
  Claim,
  EvidenceSource,
  LanguageContent,
  ManipulationTactic,
  MisinformationVaccine,
  OverallRisk,
  RiskMetrics,
  StanceType,
  TacticCategory,
} from '../types';

const TACTIC_CATEGORIES: TacticCategory[] = [
  'fear',
  'urgency',
  'authority',
  'clickbait',
  'emotion',
  'statistics',
  'social',
  'conspiracy',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function normalizeSource(value: unknown, index: number): EvidenceSource | null {
  if (!isRecord(value)) return null;
  const types: EvidenceSource['type'][] = ['Government', 'Scientific', 'Fact Check', 'News', 'Unknown'];
  const reliabilities: EvidenceSource['reliability'][] = ['High', 'Medium', 'Low'];
  const stances: StanceType[] = ['Contradicting', 'Supporting', 'Context'];
  return {
    id: asText(value.id, `source-${index + 1}`),
    title: asText(value.title, 'Source details unavailable'),
    publisher: asText(value.publisher, 'Unknown publisher'),
    type: types.includes(value.type as EvidenceSource['type']) ? value.type as EvidenceSource['type'] : 'Unknown',
    reliability: reliabilities.includes(value.reliability as EvidenceSource['reliability'])
      ? value.reliability as EvidenceSource['reliability']
      : 'Low',
    date: asText(value.date, 'Date unavailable'),
    url: asText(value.url),
    stance: stances.includes(value.stance as StanceType) ? value.stance as StanceType : 'Context',
    quote: asText(value.quote),
    isDemo: value.isDemo === true,
  };
}

function normalizeClaim(value: unknown, index: number): Claim | null {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) return null;
  const verdicts: Claim['verdict'][] = ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIED'];
  const sources = Array.isArray(value.sources)
    ? value.sources.map(normalizeSource).filter((source): source is EvidenceSource => source !== null)
    : [];
  return {
    id: asText(value.id, `claim-${index + 1}`),
    text: value.text,
    verdict: verdicts.includes(value.verdict as Claim['verdict'])
      ? value.verdict as Claim['verdict']
      : 'UNVERIFIED',
    confidence: asScore(value.confidence),
    explanation: asText(value.explanation, 'No explanation was provided.'),
    sources,
  };
}

function normalizeTactic(value: unknown, index: number): ManipulationTactic | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (!TACTIC_CATEGORIES.includes(value.category as TacticCategory)) return null;
  return {
    id: asText(value.id, `tactic-${index + 1}`),
    name: value.name,
    category: value.category as TacticCategory,
    matchedText: asText(value.matchedText),
    explanation: asText(value.explanation, 'No explanation was provided.'),
    userTip: asText(value.userTip, 'Check this claim against a reliable source.'),
    color: asText(value.color, '#06b6d4'),
  };
}

function normalizeLanguageContent(value: unknown, label: string): LanguageContent {
  const content = isRecord(value) ? value : {};
  return {
    verdictLabel: asText(content.verdictLabel, label),
    summary: asText(content.summary, 'No translated summary is available.'),
    eli15: asText(content.eli15, 'No simplified explanation is available.'),
    actionTip: asText(content.actionTip, 'Check claims against reliable sources before sharing.'),
  };
}

function normalizeVaccine(value: unknown): MisinformationVaccine {
  const source = isRecord(value) ? value : {};
  const quiz = isRecord(source.microQuiz) ? source.microQuiz : {};
  const options = Array.isArray(quiz.options)
    ? quiz.options.filter((option): option is string => typeof option === 'string')
    : [];
  return {
    tacticEncountered: asText(source.tacticEncountered, 'Verification reminder'),
    howTrickWorks: asText(source.howTrickWorks, 'Claims can spread before they are checked.'),
    howToProtect: asText(source.howToProtect, 'Pause and check reliable sources before sharing.'),
    nextTimeExample: asText(source.nextTimeExample, 'Check the original source before forwarding a claim.'),
    microQuiz: {
      question: asText(quiz.question, 'What should you do before sharing an unverified claim?'),
      options: options.length ? options : ['Check a reliable source', 'Forward it immediately'],
      correctIndex: Number.isInteger(quiz.correctIndex)
        && Number(quiz.correctIndex) >= 0
        && Number(quiz.correctIndex) < (options.length || 2)
        ? Number(quiz.correctIndex)
        : 0,
      explanation: asText(quiz.explanation, 'Checking reliable sources helps prevent misinformation from spreading.'),
    },
  };
}

function normalizeMetrics(value: unknown): RiskMetrics {
  const metrics = isRecord(value) ? value : {};
  return {
    truthfulness: asScore(metrics.truthfulness),
    evidenceStrength: asScore(metrics.evidenceStrength),
    manipulationRisk: asScore(metrics.manipulationRisk),
    sourceReliability: asScore(metrics.sourceReliability),
  };
}

const VERDICT_LABELS: Record<OverallRisk, Record<'en' | 'ta' | 'hi' | 'ml', string>> = {
  'HIGH RISK': {
    en: 'High misinformation risk',
    ta: 'அதிக தவறான தகவல் ஆபத்து',
    hi: 'उच्च भ्रामक जानकारी जोखिम',
    ml: 'ഉയർന്ന തെറ്റായ വിവര സാധ്യത',
  },
  'MODERATE RISK': {
    en: 'Moderate misinformation risk',
    ta: 'மிதமான தவறான தகவல் ஆபத்து',
    hi: 'मध्यम भ्रामक जानकारी जोखिम',
    ml: 'മിതമായ തെറ്റായ വിവര സാധ്യത',
  },
  'LOW RISK': {
    en: 'Low misinformation risk',
    ta: 'குறைந்த தவறான தகவல் ஆபத்து',
    hi: 'कम भ्रामक जानकारी जोखिम',
    ml: 'കുറഞ്ഞ തെറ്റായ വിവര സാധ്യത',
  },
  'UNVERIFIED RISK': {
    en: 'Unverified — insufficient evidence',
    ta: 'சரிபார்க்கப்படவில்லை — போதிய ஆதாரம் இல்லை',
    hi: 'असत्यापित — पर्याप्त प्रमाण नहीं',
    ml: 'സ്ഥിരീകരിച്ചിട്ടില്ല — മതിയായ തെളിവില്ല',
  },
};

export function normalizeAssessmentRisk(result: AnalysisResult): AnalysisResult {
  const input: Record<string, unknown> = isRecord(result) ? result : {};
  const claims = Array.isArray(input.claims)
    ? input.claims.map(normalizeClaim).filter((claim): claim is Claim => claim !== null)
    : [];
  const tactics = Array.isArray(input.tactics)
    ? input.tactics.map(normalizeTactic).filter((tactic): tactic is ManipulationTactic => tactic !== null)
    : [];
  const rawTranslations = isRecord(input.translations) ? input.translations : {};
  const summary = asText(input.summary, 'Analysis summary is unavailable.');
  const rawText = asText(input.rawText, 'Uploaded content');
  const metrics = normalizeMetrics(input.metrics);

  const hasConfirmedMisinformation = claims.some(
    ({ verdict }) => verdict === 'FALSE' || verdict === 'MISLEADING',
  );

  let overallRisk: OverallRisk;
  let riskScore: number;

  if (!hasConfirmedMisinformation) {
    const allClaimsVerifiedTrue = claims.length > 0
      && claims.every(({ verdict }) => verdict === 'TRUE');
    overallRisk = allClaimsVerifiedTrue ? 'LOW RISK' : 'UNVERIFIED RISK';
    riskScore = 0;
  } else {
    riskScore = typeof input.riskScore === 'number' && Number.isFinite(input.riskScore)
      ? Math.max(55, Math.min(100, Math.round(input.riskScore)))
      : 55;
    overallRisk = riskScore >= 80 ? 'HIGH RISK' : 'MODERATE RISK';
  }

  const rawImageAnalysis = isRecord(input.imageAnalysis) ? input.imageAnalysis : null;
  const imageEstimateValues: NonNullable<AnalysisResult['imageAnalysis']>['isAiGeneratedEstimate'][] = [
    'Likely AI-generated',
    'Possibly edited',
    'No obvious AI indicators',
    'Unable to determine',
  ];
  const imageAnalysis = rawImageAnalysis
    ? {
        isAiGeneratedEstimate: imageEstimateValues.includes(
          rawImageAnalysis.isAiGeneratedEstimate as NonNullable<AnalysisResult['imageAnalysis']>['isAiGeneratedEstimate'],
        )
          ? rawImageAnalysis.isAiGeneratedEstimate as NonNullable<AnalysisResult['imageAnalysis']>['isAiGeneratedEstimate']
          : 'Unable to determine' as const,
        confidence: Math.min(
          typeof rawImageAnalysis.confidence === 'number' && Number.isFinite(rawImageAnalysis.confidence)
            ? Math.max(0, Math.min(100, Math.round(rawImageAnalysis.confidence)))
            : 0,
          rawImageAnalysis.isAiGeneratedEstimate === 'Unable to determine'
            ? 25
            : rawImageAnalysis.isAiGeneratedEstimate === 'No obvious AI indicators'
              ? 50
              : rawImageAnalysis.isAiGeneratedEstimate === 'Possibly edited'
                ? 65
                : 85,
        ),
        signals: Array.isArray(rawImageAnalysis.signals)
          ? rawImageAnalysis.signals.filter((signal): signal is string => typeof signal === 'string')
          : [],
        reverseSearchQuery: asText(rawImageAnalysis.reverseSearchQuery, rawText.slice(0, 60)),
        disclaimer: asText(
          rawImageAnalysis.disclaimer,
          'Visual indicators are an estimate and do not prove whether an image is authentic.',
        ),
      }
    : undefined;

  return {
    id: asText(input.id, `analysis-${Date.now()}`),
    rawText,
    title: asText(input.title) || undefined,
    sourceType: input.sourceType === 'screenshot' || input.sourceType === 'url' ? input.sourceType : 'text',
    overallRisk,
    riskScore,
    confidenceScore: asScore(input.confidenceScore),
    summary,
    verificationNote: asText(input.verificationNote) || undefined,
    metrics,
    claims,
    tactics,
    eli15Explanation: asText(input.eli15Explanation, 'Check claims against reliable sources before sharing.'),
    translations: {
      en: normalizeLanguageContent(rawTranslations.en, VERDICT_LABELS[overallRisk].en),
      ta: normalizeLanguageContent(rawTranslations.ta, VERDICT_LABELS[overallRisk].ta),
      hi: normalizeLanguageContent(rawTranslations.hi, VERDICT_LABELS[overallRisk].hi),
      ml: normalizeLanguageContent(rawTranslations.ml, VERDICT_LABELS[overallRisk].ml),
    },
    vaccine: normalizeVaccine(input.vaccine),
    imageAnalysis,
    timestamp: asText(input.timestamp, new Date().toISOString()),
  };
}
