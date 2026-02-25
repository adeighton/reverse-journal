import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, generateObject, streamObject } from "ai";

const anthropic = createAnthropic();

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

const DEFAULT_MODEL = MODELS.sonnet;

/**
 * Generate a complete text response from Claude.
 */
export async function generate(prompt, { system, maxTokens = 4096, model } = {}) {
  const result = await generateText({
    model: anthropic(model || DEFAULT_MODEL),
    system,
    prompt,
    maxTokens,
  });
  return result.text;
}

/**
 * Stream a text response from Claude, calling onChunk for each piece.
 */
export async function stream(prompt, { system, maxTokens = 4096, onChunk, model } = {}) {
  const result = streamText({
    model: anthropic(model || DEFAULT_MODEL),
    system,
    prompt,
    maxTokens,
  });

  let full = "";
  for await (const chunk of result.textStream) {
    full += chunk;
    if (onChunk) onChunk(chunk);
  }
  // Await the response to surface any errors from background SDK promises
  // (e.g. 529 overloaded errors that textStream doesn't propagate)
  await result.response;
  return full;
}

/**
 * Generate a structured object response validated against a Zod schema.
 *
 * @param {string} prompt
 * @param {import("zod").ZodType} schema - Zod schema defining the expected output shape
 * @param {object} [opts]
 * @returns {Promise<object>} The validated object
 */
export async function generateStructured(prompt, schema, { system, maxTokens = 4096, model } = {}) {
  const result = await generateObject({
    model: anthropic(model || DEFAULT_MODEL),
    system,
    prompt,
    schema,
    maxTokens,
  });
  return result.object;
}

/**
 * Stream a structured object response, calling onPartial as the object builds up.
 *
 * @param {string} prompt
 * @param {import("zod").ZodType} schema - Zod schema defining the expected output shape
 * @param {object} [opts]
 * @returns {Promise<object>} The final validated object
 */
export async function streamStructured(prompt, schema, { system, maxTokens = 4096, onPartial, model } = {}) {
  const result = streamObject({
    model: anthropic(model || DEFAULT_MODEL),
    system,
    prompt,
    schema,
    maxTokens,
  });

  let final;
  for await (const partial of result.partialObjectStream) {
    final = partial;
    if (onPartial) onPartial(partial);
  }
  return final;
}
