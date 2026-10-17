import type { TaskRunEvent } from '@prisma/client';

/** Emit complete paragraphs once, even when their tokens span multiple relay polls. */
export function completedReplyParagraphs(output: Pick<TaskRunEvent, 'sequence' | 'content'>[], afterSequence: number) {
  let text = '';
  const ends = output.map((event) => {
    text += event.content;
    return { sequence: event.sequence, offset: text.length };
  });
  const paragraphs: { sequence: number; text: string }[] = [];
  let start = 0;
  for (let end = text.indexOf('\n\n', start); end !== -1; end = text.indexOf('\n\n', start)) {
    const sequence = ends.find((event) => event.offset >= end + 2)?.sequence;
    const paragraph = text.slice(start, end).trim();
    if (sequence !== undefined && sequence > afterSequence && paragraph) paragraphs.push({ sequence, text: paragraph });
    start = end + 2;
  }
  return paragraphs;
}
