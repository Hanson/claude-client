/**
 * Markdown 转飞书富文本格式转换器
 */

/**
 * 飞书富文本段
 */
interface RichTextSegment {
  tag: 'text' | 'a' | 'at' | 'img';
  text?: string;
  href?: string;
  user_id?: string;
  image_key?: string;
  style?: string[];
}

/**
 * 飞书富文本行
 */
interface RichTextParagraph {
  tag: 'div' | 'ol' | 'ul' | 'code' | 'quote' | 'hr';
  segments?: RichTextSegment[];
  code?: string;
  language?: string;
  indent?: number;
}

/**
 * 将 Markdown 转换为飞书富文本格式
 */
export function markdownToRichText(markdown: string): RichTextParagraph[] {
  const paragraphs: RichTextParagraph[] = [];
  const lines = markdown.split('\n');

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeLanguage = '';
  let currentParagraph: RichTextSegment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 处理代码块
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        // 开始代码块
        if (currentParagraph.length > 0) {
          paragraphs.push({ tag: 'div', segments: currentParagraph });
          currentParagraph = [];
        }
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeBlockContent = [];
      } else {
        // 结束代码块
        inCodeBlock = false;
        paragraphs.push({
          tag: 'code',
          code: codeBlockContent.join('\n'),
          language: codeLanguage || 'plaintext',
        });
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // 处理水平线
    if (line.match(/^(---|\*\*\*|___)$/)) {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      paragraphs.push({ tag: 'hr' });
      continue;
    }

    // 处理空行
    if (line.trim() === '') {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      continue;
    }

    // 处理标题
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      const headerText = headerMatch[2];
      const segments = parseInlineMarkdown(headerText);
      // 给标题加粗
      for (const seg of segments) {
        if (!seg.style) seg.style = [];
        if (!seg.style.includes('bold')) seg.style.push('bold');
      }
      paragraphs.push({ tag: 'div', segments });
      continue;
    }

    // 处理无序列表
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      const indent = Math.floor(ulMatch[1].length / 2);
      const segments = parseInlineMarkdown(ulMatch[2]);
      // 添加列表标记
      segments.unshift({ tag: 'text', text: '• ' });
      paragraphs.push({ tag: 'ul', segments, indent });
      continue;
    }

    // 处理有序列表
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      const indent = Math.floor(olMatch[1].length / 2);
      const num = olMatch[2];
      const segments = parseInlineMarkdown(olMatch[3]);
      segments.unshift({ tag: 'text', text: `${num}. ` });
      paragraphs.push({ tag: 'ol', segments, indent });
      continue;
    }

    // 处理引用
    if (line.startsWith('> ')) {
      if (currentParagraph.length > 0) {
        paragraphs.push({ tag: 'div', segments: currentParagraph });
        currentParagraph = [];
      }
      const quoteText = line.slice(2);
      const segments = parseInlineMarkdown(quoteText);
      paragraphs.push({ tag: 'quote', segments });
      continue;
    }

    // 普通文本，累积到当前段落
    const segments = parseInlineMarkdown(line);
    if (currentParagraph.length > 0) {
      currentParagraph.push({ tag: 'text', text: '\n' });
    }
    currentParagraph.push(...segments);
  }

  // 处理剩余内容
  if (inCodeBlock) {
    paragraphs.push({
      tag: 'code',
      code: codeBlockContent.join('\n'),
      language: codeLanguage || 'plaintext',
    });
  } else if (currentParagraph.length > 0) {
    paragraphs.push({ tag: 'div', segments: currentParagraph });
  }

  return paragraphs;
}

/**
 * 解析行内 Markdown（粗体、斜体、代码、链接）
 */
function parseInlineMarkdown(text: string): RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // 尝试匹配行内代码
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      segments.push({
        tag: 'text',
        text: codeMatch[1],
        style: ['inline_code'],
      });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 尝试匹配链接
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      segments.push({
        tag: 'a',
        text: linkMatch[1],
        href: linkMatch[2],
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 尝试匹配粗体
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      segments.push({
        tag: 'text',
        text: boldMatch[1],
        style: ['bold'],
      });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 尝试匹配斜体
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      segments.push({
        tag: 'text',
        text: italicMatch[1],
        style: ['italic'],
      });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // 尝试匹配删除线
    const strikeMatch = remaining.match(/^~~([^~]+)~~/);
    if (strikeMatch) {
      segments.push({
        tag: 'text',
        text: strikeMatch[1],
        style: ['strikethrough'],
      });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // 普通文本，找到下一个特殊字符
    let nextSpecial = remaining.length;
    const patterns = ['`', '[', '**', '*', '~~'];
    for (const pattern of patterns) {
      const idx = remaining.indexOf(pattern);
      if (idx !== -1 && idx < nextSpecial) {
        nextSpecial = idx;
      }
    }

    if (nextSpecial > 0) {
      segments.push({
        tag: 'text',
        text: remaining.slice(0, nextSpecial),
      });
      remaining = remaining.slice(nextSpecial);
    } else if (nextSpecial === 0) {
      // 无法解析的特殊字符，作为普通文本处理
      segments.push({
        tag: 'text',
        text: remaining[0],
      });
      remaining = remaining.slice(1);
    } else {
      break;
    }
  }

  return segments;
}

/**
 * 将富文本段转换为飞书消息内容 JSON 字符串
 */
export function toFeishuContent(paragraphs: RichTextParagraph[]): string {
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: paragraphs.map(p => {
        if (p.tag === 'hr') {
          return [{ tag: 'hr' }];
        }
        if (p.tag === 'code') {
          return [{
            tag: 'code',
            text: p.code || '',
            language: p.language || 'plaintext',
          }];
        }
        if (p.tag === 'quote') {
          return [{
            tag: 'quote',
            text: p.segments?.map(s => s.text || '').join('') || '',
          }];
        }
        if (p.segments) {
          return p.segments.map(s => {
            if (s.tag === 'a') {
              return {
                tag: 'a',
                text: s.text || '',
                href: s.href || '',
              };
            }
            if (s.tag === 'at') {
              return {
                tag: 'at',
                user_id: s.user_id || '',
              };
            }
            return {
              tag: 'text',
              text: s.text || '',
              style: s.style,
            };
          });
        }
        return [];
      }),
    },
  });
}
