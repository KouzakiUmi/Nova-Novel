export interface RevisionInsights {
  paragraphCount: number;
  sentenceCount: number;
  averageSentenceLength: number;
  shortParagraphRatio: number;
  repeatedStarts: Array<{ text: string; count: number }>;
}

/** 可解释的文本观察，只用于提示作者，不作为质量评分。 */
export function analyzeRevisionText(body: string): RevisionInsights {
  const paragraphs = body.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const sentences = body.split(/[\n。！？!?；;]+/u).map(part => part.trim()).filter(Boolean);
  const lengths = sentences.map(sentence => sentence.replace(/\s/g, "").length);
  const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
  const starts = new Map<string, number>();
  for (const sentence of sentences) {
    const start = sentence.replace(/\s/g, "").slice(0, 4);
    if (start.length >= 4) starts.set(start, (starts.get(start) ?? 0) + 1);
  }
  return {
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    averageSentenceLength: Math.round(average * 10) / 10,
    shortParagraphRatio: paragraphs.length ? Math.round(paragraphs.filter(paragraph => paragraph.replace(/\s/g, "").length < 80).length / paragraphs.length * 100) : 0,
    repeatedStarts: [...starts.entries()].filter(([, count]) => count > 1).map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  };
}
