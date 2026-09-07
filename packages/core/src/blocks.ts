import type { ContentBlock } from "./types.js";

/** Helpers to build content blocks concisely: `text("hi")`, `image(url)`. */

export const text = (t: string, format?: "plain" | "markdown" | "html"): ContentBlock => ({
  type: "text",
  text: t,
  ...(format ? { format } : {}),
});

export const image = (url: string, caption?: string): ContentBlock => ({
  type: "image",
  url,
  ...(caption !== undefined ? { caption } : {}),
});

export const audio = (url: string, durationSec?: number): ContentBlock => ({
  type: "audio",
  url,
  ...(durationSec !== undefined ? { durationSec } : {}),
});

export const video = (url: string, caption?: string, durationSec?: number): ContentBlock => ({
  type: "video",
  url,
  ...(caption !== undefined ? { caption } : {}),
  ...(durationSec !== undefined ? { durationSec } : {}),
});

export const file = (
  url: string,
  filename?: string,
  mimetype?: string
): ContentBlock => ({
  type: "file",
  url,
  ...(filename !== undefined ? { filename } : {}),
  ...(mimetype !== undefined ? { mimetype } : {}),
});

export const location = (
  latitude: number,
  longitude: number,
  title?: string,
  address?: string
): ContentBlock => ({
  type: "location",
  latitude,
  longitude,
  ...(title !== undefined ? { title } : {}),
  ...(address !== undefined ? { address } : {}),
});

export const sticker = (id: string): ContentBlock => ({ type: "sticker", id });

export const contact = (c: {
  name?: string;
  phone?: string;
  email?: string;
  userId?: string;
}): ContentBlock => ({ type: "contact", ...c });

export const template = (
  templateName: string,
  params: Record<string, string>
): ContentBlock => ({ type: "template", template: templateName, params });

/** Flatten blocks into a single plain-text string (for logging / previews). */
export function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "text":
          return b.text;
        case "image":
        case "video":
          return b.caption ?? `[${b.type}]`;
        case "file":
          return `[file: ${b.filename ?? b.url}]`;
        case "location":
          return `[location: ${b.latitude},${b.longitude}]`;
        case "contact":
          return `[contact: ${b.name ?? b.phone ?? b.email ?? ""}]`;
        case "sticker":
          return `[sticker]`;
        case "template":
          return `[template: ${b.template}]`;
        default:
          return `[${(b as ContentBlock).type}]`;
      }
    })
    .join(" ");
}
