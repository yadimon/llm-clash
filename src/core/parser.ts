import type { CandidateScore, Draft, EvaluationCriterion, EvaluationResult } from "./types.js";
import { criterionLabel } from "./prompts.js";

export type CandidateBlock = {
  index: number;
  body: string;
};

const SCORE_PATTERN = "(-?\\d+(?:\\.\\d+)?)\\s*(?:\\/\\s*10)?";

export function splitCandidateBlocks(markdown: string): CandidateBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: CandidateBlock[] = [];
  let current: { index: number; lines: string[] } | undefined;

  for (const line of lines) {
    const header = line.match(/^#{1,3}\s*Candidate\s+(\d+)\b/i);
    if (header?.[1]) {
      if (current) {
        blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
      }
      current = { index: Number.parseInt(header[1], 10), lines: [] };
      continue;
    }

    if (/^#\s*(Best Candidate|Reason)\b/i.test(line)) {
      if (current) {
        blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
        current = undefined;
      }
      continue;
    }

    current?.lines.push(line);
  }

  if (current) {
    blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
  }

  return blocks;
}

export function parseCandidateBlock(
  body: string,
  criteria: EvaluationCriterion[]
): {
  scores: Partial<Record<EvaluationCriterion, number>>;
  total?: number | undefined;
  strengths: string[];
  weaknesses: string[];
} {
  const scores: Partial<Record<EvaluationCriterion, number>> = {};
  let total: number | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*\s]+/, "").trim();
    if (!line) {
      continue;
    }

    for (const criterion of criteria) {
      const label = criterionLabel(criterion).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const looseLabel = label.replace(/\s+/g, "[\\s_-]+");
      const match = line.match(new RegExp(`^${looseLabel}\\s*[:\\-]\\s*${SCORE_PATTERN}`, "i"));
      if (match?.[1]) {
        scores[criterion] = clampScore(Number.parseFloat(match[1]));
        break;
      }
    }

    const totalMatch = line.match(new RegExp(`^Total\\s*[:\\-]\\s*${SCORE_PATTERN}`, "i"));
    if (totalMatch?.[1]) {
      total = clampScore(Number.parseFloat(totalMatch[1]));
    }
  }

  const { strengths, weaknesses } = parseStrengthsWeaknesses(body);
  return { scores, total, strengths, weaknesses };
}

export function parseStrengthsWeaknesses(body: string): {
  strengths: string[];
  weaknesses: string[];
} {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  let mode: "strengths" | "weaknesses" | undefined;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^Strengths\s*:?$/i.test(trimmed)) {
      mode = "strengths";
      continue;
    }
    if (/^Weaknesses\s*:?$/i.test(trimmed)) {
      mode = "weaknesses";
      continue;
    }
    if (!trimmed) {
      mode = undefined;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (!bullet?.[1] || !mode) {
      continue;
    }
    if (mode === "strengths") {
      strengths.push(bullet[1]);
    } else {
      weaknesses.push(bullet[1]);
    }
  }

  return { strengths, weaknesses };
}

export function parseBestCandidate(markdown: string): {
  index?: number | undefined;
  reason?: string | undefined;
} {
  const bestMatch = markdown.match(/#\s*Best Candidate\s*\n+([\s\S]*?)(?=\n#\s|$)/i);
  const candidateMatch = bestMatch?.[1]?.match(/Candidate\s+(\d+)/i);
  const reasonMatch = markdown.match(/#\s*Reason\s*\n+([\s\S]*?)$/i);
  return {
    index: candidateMatch?.[1] ? Number.parseInt(candidateMatch[1], 10) : undefined,
    reason: reasonMatch?.[1]?.trim()
  };
}

export function parseEvaluationText(
  text: string,
  candidates: Draft[],
  criteria: EvaluationCriterion[],
  judgeModelId = "unknown"
): EvaluationResult {
  const blocks = splitCandidateBlocks(text);
  const candidateScores: CandidateScore[] = candidates.map((candidate, index) => {
    const block = blocks.find((candidateBlock) => candidateBlock.index === index + 1);
    const parsed = block
      ? parseCandidateBlock(block.body, criteria)
      : { scores: {}, total: undefined, strengths: [], weaknesses: [] };
    const total =
      parsed.total ??
      average(
        Object.values(parsed.scores).filter((score): score is number => typeof score === "number")
      );

    return {
      candidateId: candidate.id,
      modelId: candidate.modelId,
      scores: parsed.scores,
      total,
      strengths: parsed.strengths,
      weaknesses: parsed.weaknesses
    };
  });

  const best = parseBestCandidate(text);
  const bestCandidateId =
    best.index !== undefined && best.index >= 1 && best.index <= candidates.length
      ? candidates[best.index - 1]?.id
      : undefined;

  return {
    judgeModelId,
    text,
    candidateScores,
    bestCandidateId,
    reason: best.reason
  };
}

export function extractImprovedAnswer(markdown: string): {
  answer: string;
  notes?: string | undefined;
} {
  const answerMatch = markdown.match(
    /#\s*Improved Answer\s*\n*([\s\S]*?)(?=\n#\s*Changes Made\b|$)/i
  );
  const notesMatch = markdown.match(/#\s*Changes Made\s*\n*([\s\S]*)$/i);
  return {
    answer: (answerMatch?.[1] ?? markdown).trim(),
    notes: notesMatch?.[1]?.trim()
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(10, value));
}
