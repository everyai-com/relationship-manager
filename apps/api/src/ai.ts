import type { AiBinding } from "@rel/core";
import type { Env } from "./env";

const DEFAULT_AI_MODEL = "@cf/zai-org/glm-5.3-flash";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Workers AI, wrapped so the domain layer never sees the binding. If the binding
 * is absent the model-backed tools say so instead of failing obscurely.
 *
 * glm-5.3-flash is a *reasoning* model: it spends completion tokens on
 * `reasoning_content` before writing `content`, so the budget has to be
 * generous or the answer comes back empty. We keep thinking on — turning it off
 * makes the model leak its scratch work into the answer.
 */
export interface StreamingAiBinding extends AiBinding {
  /** Streamed answer text — content deltas only, reasoning stripped. */
  runStream: (opts: { messages: ChatTurn[] }) => Promise<ReadableStream<string>>;
}

export function aiFrom(env: Env): StreamingAiBinding | null {
  const binding = env.AI;
  if (!binding) return null;
  const model = env.AI_MODEL && env.AI_MODEL.trim() ? env.AI_MODEL.trim() : DEFAULT_AI_MODEL;

  const runOnce = async ({ system, user }: { system: string; user: string }): Promise<string> => {
    const result = (await binding.run(model as never, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 2048,
      temperature: 0.2,
    } as never)) as unknown;

    const text = extractModelText(result).trim();
    if (!text) {
      throw new Error(
        `the model (${model}) returned no answer — it may have spent its whole budget reasoning. Try again, or ask a narrower question.`,
      );
    }
    return text;
  };

  /** The last user turn, for the non-streaming fallback. */
  const fallback = (messages: ChatTurn[]) => {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return runOnce({ system, user });
  };

  return {
    model,
    run: runOnce,
    runStream: async ({ messages }) => {
      let raw: unknown = null;
      try {
        raw = await binding.run(model as never, {
          messages,
          stream: true,
          max_tokens: 2048,
          temperature: 0.2,
        } as never);
      } catch {
        raw = null;
      }

      if (!isReadableStream(raw)) {
        // Streaming is not available for this model — answer the old way, in one piece.
        return singleChunk(await fallback(messages));
      }
      return contentStream(raw, () => fallback(messages));
    },
  };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof (value as ReadableStream).getReader === "function");
}

function singleChunk(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

/**
 * Workers AI streams SSE (`data: {...choices[].delta.content}`); the UI wants
 * plain text. Reasoning deltas are dropped — the model's scratch work is not the
 * answer. If the stream ends without a single content delta, the non-streaming
 * call runs once so a reasoning-heavy turn is slow, never silent.
 */
function contentStream(source: ReadableStream<Uint8Array>, recover: () => Promise<string>): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let emitted = 0;

  const parse = (line: string, controller: TransformStreamDefaultController<string>) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const text = deltaText(parsed);
    if (text) {
      emitted += text.length;
      controller.enqueue(text);
    }
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parse(line, controller);
      },
      async flush(controller) {
        parse(buffer, controller);
        if (emitted > 0) return;
        try {
          const text = (await recover()).trim();
          if (text) controller.enqueue(text);
        } catch {
          // The caller decides what an empty answer means.
        }
      },
    }),
  );
}

/** Content from a streamed chunk — chat deltas first, legacy text models second. */
function deltaText(value: unknown): string {
  if (typeof value === "string") return value;
  const chunk = value as {
    response?: unknown;
    choices?: Array<{ delta?: { content?: unknown }; text?: unknown }>;
  } | null;
  if (!chunk) return "";
  const choice = chunk.choices?.[0];
  if (choice?.delta && typeof choice.delta.content === "string") return choice.delta.content;
  if (choice && typeof choice.text === "string") return choice.text;
  if (typeof chunk.response === "string") return chunk.response;
  return "";
}

/** Chat models return choices[].message.content; older text models return `response`. */
export function extractModelText(result: unknown): string {
  if (typeof result === "string") return result;
  const value = result as
    | { response?: unknown; choices?: Array<{ message?: { content?: unknown }; text?: unknown }>; result?: { response?: unknown } }
    | null;
  if (!value) return "";
  if (typeof value.response === "string") return value.response;
  if (typeof value.result?.response === "string") return value.result.response;
  const choice = value.choices?.[0];
  if (choice) {
    if (typeof choice.message?.content === "string") return choice.message.content;
    if (typeof choice.text === "string") return choice.text;
  }
  return "";
}

export { DEFAULT_AI_MODEL };
