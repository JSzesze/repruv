type UnknownRecord = Record<string, unknown>;

type DraftRange = {
  key?: number;
  length?: number;
  offset?: number;
  style?: string;
};

type DraftBlock = {
  data?: UnknownRecord;
  entityRanges?: DraftRange[];
  inlineStyleRanges?: DraftRange[];
  text?: string;
  type?: string;
};

type DraftEntity = {
  data?: UnknownRecord;
  type?: string;
};

type ArticleMedia = {
  media_id?: string;
  media_info?: {
    original_img_url?: string;
    preview_image?: { original_img_url?: string };
    variants?: Array<{
      bit_rate?: number;
      content_type?: string;
      url?: string;
    }>;
  };
};

type FxArticle = {
  content?: {
    blocks?: DraftBlock[];
    entityMap?: unknown;
  };
  cover_media?: ArticleMedia;
  media_entities?: ArticleMedia[];
  preview_text?: string;
  title?: string;
};

type FxTweet = {
  article?: FxArticle;
  author?: {
    name?: string;
    screen_name?: string;
  };
  created_at?: string;
  media?: Array<{
    altText?: string;
    type?: string;
    url?: string;
  }>;
  text?: string;
};

export type XMarkdownResult = {
  author: string | null;
  blockCount: number;
  entityCount: number;
  markdown: string;
  title: string;
};

type Decoration = {
  close: string;
  end: number;
  open: string;
  priority: number;
  start: number;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeEntityMap(value: unknown): Map<number, DraftEntity> {
  const entities = new Map<number, DraftEntity>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      const entity = asRecord(record?.value);
      const key = Number(record?.key);
      if (Number.isFinite(key) && entity) {
        entities.set(key, entity as DraftEntity);
      }
    }
    return entities;
  }

  const record = asRecord(value);
  if (!record) return entities;

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const wrapper = asRecord(rawValue);
    const entity = asRecord(wrapper?.value) ?? wrapper;
    const logicalKey = Number(wrapper?.key ?? rawKey);
    if (Number.isFinite(logicalKey) && entity) {
      entities.set(logicalKey, entity as DraftEntity);
    }
  }

  return entities;
}

function styleDecoration(range: DraftRange): Decoration | null {
  if (
    typeof range.offset !== "number" ||
    typeof range.length !== "number" ||
    range.length <= 0
  ) {
    return null;
  }

  const markers: Record<string, Pick<Decoration, "close" | "open" | "priority">> = {
    Bold: { open: "**", close: "**", priority: 20 },
    Italic: { open: "_", close: "_", priority: 30 },
    Underline: { open: "<u>", close: "</u>", priority: 40 },
    Strikethrough: { open: "~~", close: "~~", priority: 50 },
    Code: { open: "`", close: "`", priority: 60 },
    Monospace: { open: "`", close: "`", priority: 60 },
  };
  const marker = range.style ? markers[range.style] : undefined;
  if (!marker) return null;

  return {
    ...marker,
    start: range.offset,
    end: range.offset + range.length,
  };
}

function entityDecoration(
  range: DraftRange,
  entities: Map<number, DraftEntity>,
): Decoration | null {
  if (
    typeof range.key !== "number" ||
    typeof range.offset !== "number" ||
    typeof range.length !== "number" ||
    range.length <= 0
  ) {
    return null;
  }

  const entity = entities.get(range.key);
  if (entity?.type !== "LINK") return null;
  const url = asString(entity.data?.url);
  if (!url) return null;

  return {
    open: "[",
    close: `](${url})`,
    priority: 10,
    start: range.offset,
    end: range.offset + range.length,
  };
}

function renderInlineText(
  text: string,
  styles: DraftRange[],
  entityRanges: DraftRange[],
  entities: Map<number, DraftEntity>,
) {
  const decorations = [
    ...styles.map(styleDecoration),
    ...entityRanges.map((range) => entityDecoration(range, entities)),
  ].filter((value): value is Decoration => Boolean(value));

  if (decorations.length === 0) return text;

  const opens = new Map<number, Decoration[]>();
  const closes = new Map<number, Decoration[]>();
  for (const decoration of decorations) {
    if (decoration.start < 0 || decoration.end > text.length) continue;
    opens.set(decoration.start, [...(opens.get(decoration.start) ?? []), decoration]);
    closes.set(decoration.end, [...(closes.get(decoration.end) ?? []), decoration]);
  }

  let rendered = "";
  for (let index = 0; index <= text.length; index += 1) {
    const ending = closes.get(index);
    if (ending) {
      ending
        .sort((a, b) => b.start - a.start || b.priority - a.priority)
        .forEach((decoration) => {
          rendered += decoration.close;
        });
    }

    const starting = opens.get(index);
    if (starting) {
      starting
        .sort((a, b) => b.end - a.end || a.priority - b.priority)
        .forEach((decoration) => {
          rendered += decoration.open;
        });
    }

    if (index < text.length) rendered += text[index];
  }

  return rendered;
}

function mediaUrl(media: ArticleMedia | undefined) {
  return (
    media?.media_info?.original_img_url ??
    media?.media_info?.preview_image?.original_img_url
  );
}

function resolveMediaLines(
  entity: DraftEntity,
  mediaById: Map<string, ArticleMedia>,
) {
  if (entity.type !== "MEDIA" && entity.type !== "IMAGE") return [];
  const data = entity.data ?? {};
  const caption = asString(data.caption)?.trim() ?? "";
  const mediaItems = Array.isArray(data.mediaItems) ? data.mediaItems : [];
  const lines: string[] = [];

  for (const rawItem of mediaItems) {
    const item = asRecord(rawItem);
    const id = asString(item?.mediaId) ?? asString(item?.media_id);
    const media = id ? mediaById.get(id) : undefined;
    const image = mediaUrl(media);
    const variants = media?.media_info?.variants ?? [];
    const video = variants
      .filter((variant) => variant.content_type?.includes("video"))
      .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0]?.url;

    if (image) lines.push(`![${caption.replace(/[\[\]]/g, "\\$&")}](${image})`);
    if (video) lines.push(`[Video](${video})`);
  }

  const fallbackUrl = asString(data.url);
  if (lines.length === 0 && fallbackUrl) {
    lines.push(`![${caption.replace(/[\[\]]/g, "\\$&")}](${fallbackUrl})`);
  }

  return lines;
}

function twemojiText(entity: DraftEntity) {
  if (entity.type !== "TWEMOJI") return null;
  const url = asString(entity.data?.url);
  const filename = url?.match(/\/([0-9a-f-]+)\.(?:svg|png)(?:$|\?)/i)?.[1];
  if (!filename) return null;

  try {
    return String.fromCodePoint(
      ...filename.split("-").map((codePoint) => Number.parseInt(codePoint, 16)),
    );
  } catch {
    return null;
  }
}

function atomicLines(
  block: DraftBlock,
  entities: Map<number, DraftEntity>,
  mediaById: Map<string, ArticleMedia>,
) {
  const blockEntities = (block.entityRanges ?? [])
    .map((range) => (typeof range.key === "number" ? entities.get(range.key) : undefined))
    .filter((entity): entity is DraftEntity => Boolean(entity));
  const embeddedMarkdown = blockEntities
    .map((entity) =>
      entity.type === "MARKDOWN" ? asString(entity.data?.markdown)?.trim() : undefined,
    )
    .filter((markdown): markdown is string => Boolean(markdown));

  // MARKDOWN entities already contain the complete atomic block, including
  // table emoji. Rendering its annotation entities as well would duplicate them.
  if (embeddedMarkdown.length > 0) {
    return embeddedMarkdown.map((markdown) => markdown.replace(/\r\n/g, "\n"));
  }

  const lines: string[] = [];

  for (const entity of blockEntities) {
    const media = resolveMediaLines(entity, mediaById);
    if (media.length > 0) {
      lines.push(...media);
      continue;
    }

    const emoji = twemojiText(entity);
    if (emoji) lines.push(emoji);
  }

  const fallback = block.text?.trim();
  if (lines.length === 0 && fallback) lines.push(fallback);
  return lines;
}

function renderBlocks(article: FxArticle) {
  const blocks = article.content?.blocks ?? [];
  const entities = normalizeEntityMap(article.content?.entityMap);
  const mediaById = new Map<string, ArticleMedia>();

  for (const media of article.media_entities ?? []) {
    if (media.media_id) mediaById.set(media.media_id, media);
  }
  if (article.cover_media?.media_id) {
    mediaById.set(article.cover_media.media_id, article.cover_media);
  }

  const output: string[] = [];
  let previousType = "";
  let orderedIndex = 0;

  const push = (value: string) => {
    const normalized = value.trimEnd();
    if (!normalized) return;
    if (output.length > 0 && output.at(-1) !== "") output.push("");
    output.push(normalized);
  };

  for (const block of blocks) {
    const type = block.type ?? "unstyled";
    const text = renderInlineText(
      block.text ?? "",
      block.inlineStyleRanges ?? [],
      block.entityRanges ?? [],
      entities,
    );

    if (type === "atomic") {
      for (const line of atomicLines(block, entities, mediaById)) push(line);
      previousType = type;
      orderedIndex = 0;
      continue;
    }

    const depth = typeof block.data?.depth === "number" ? block.data.depth : 0;
    const indent = "  ".repeat(Math.max(0, depth));
    if (type === "unordered-list-item") {
      if (previousType !== type && output.length > 0 && output.at(-1) !== "") output.push("");
      output.push(`${indent}- ${text}`);
      previousType = type;
      orderedIndex = 0;
      continue;
    }
    if (type === "ordered-list-item") {
      if (previousType !== type) orderedIndex = 0;
      orderedIndex += 1;
      if (previousType !== type && output.length > 0 && output.at(-1) !== "") output.push("");
      output.push(`${indent}${orderedIndex}. ${text}`);
      previousType = type;
      continue;
    }

    orderedIndex = 0;
    const headings: Record<string, string> = {
      "header-one": "##",
      "header-two": "###",
      "header-three": "####",
      "header-four": "#####",
      "header-five": "######",
      "header-six": "######",
    };

    if (headings[type]) {
      push(`${headings[type]} ${text}`);
    } else if (type === "blockquote") {
      push(text.split("\n").map((line) => `> ${line}`).join("\n"));
    } else if (type === "code-block") {
      push(`\`\`\`\n${block.text ?? ""}\n\`\`\``);
    } else {
      push(text);
    }
    previousType = type;
  }

  return {
    blockCount: blocks.length,
    entityCount: entities.size,
    markdown: output.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function getTweet(payload: unknown): FxTweet | null {
  const root = asRecord(payload);
  const tweet = asRecord(root?.tweet);
  return tweet ? (tweet as FxTweet) : null;
}

export function convertFxTwitterPayload(payload: unknown): XMarkdownResult {
  const tweet = getTweet(payload);
  if (!tweet) throw new Error("FxTwitter did not return a tweet.");

  const username = tweet.author?.screen_name;
  const author = tweet.author?.name
    ? `${tweet.author.name}${username ? ` (@${username})` : ""}`
    : username
      ? `@${username}`
      : null;

  if (tweet.article) {
    const title = tweet.article.title?.trim() || "Untitled X Article";
    const rendered = renderBlocks(tweet.article);
    const cover = mediaUrl(tweet.article.cover_media);
    const parts = [`# ${title}`];
    if (cover) parts.push(`![Cover image](${cover})`);
    if (rendered.markdown) parts.push(rendered.markdown);
    else if (tweet.article.preview_text?.trim()) parts.push(tweet.article.preview_text.trim());

    return {
      author,
      blockCount: rendered.blockCount,
      entityCount: rendered.entityCount,
      markdown: `${parts.join("\n\n").trim()}\n`,
      title,
    };
  }

  const title = username ? `Post by @${username}` : "X Post";
  const parts = [`# ${title}`];
  if (author) parts.push(`**${author}**`);
  if (tweet.text?.trim()) parts.push(tweet.text.trim());
  for (const media of tweet.media ?? []) {
    if (!media.url) continue;
    parts.push(
      media.type === "video"
        ? `[Video](${media.url})`
        : `![${media.altText ?? ""}](${media.url})`,
    );
  }

  return {
    author,
    blockCount: 0,
    entityCount: 0,
    markdown: `${parts.join("\n\n").trim()}\n`,
    title,
  };
}

export function parseXStatusUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a complete X or Twitter URL.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "x.com" && hostname !== "twitter.com") {
    throw new Error("Only x.com and twitter.com URLs are supported.");
  }

  const match = url.pathname.match(/^\/([^/]+)\/(?:status|article)\/(\d+)/i);
  if (!match || match[1].toLowerCase() === "i") {
    throw new Error(
      "Use the post URL (x.com/user/status/…) or author article URL (x.com/user/article/…).",
    );
  }

  return {
    id: match[2],
    username: match[1],
  };
}
