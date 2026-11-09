import { createHash } from 'node:crypto';

/** Matches the sha1 the ZApiDraftEdit server module compares against the stored body. */
export function draftVersion(body: string | undefined): string {
  return createHash('sha1')
    .update(body ?? '', 'utf8')
    .digest('hex');
}
