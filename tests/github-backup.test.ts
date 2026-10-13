import { describe, expect, it } from 'vitest';
import { redactRemote } from '../src/services/github-backup-service.js';

/**
 * A non-interactive `git push` needs the token in the remote URL, so
 * GITHUB_BACKUP_REPO is the one setting that legitimately holds a credential.
 * It used to be returned verbatim in the backup response and to reach the logs
 * through git's own stderr. Every exit from that module is redacted now, and
 * these tests are what hold that line.
 */
describe('github backup credential redaction', () => {
  it('strips a token from an https remote', () => {
    expect(redactRemote('https://x-access-token:ghp_abc123def456@github.com/owner/repo.git'))
      .toBe('https://***@github.com/owner/repo.git');
  });

  it('strips a user:password pair', () => {
    expect(redactRemote('https://alice:s3cret@github.com/owner/repo.git'))
      .toBe('https://***@github.com/owner/repo.git');
  });

  it('strips a bare token', () => {
    expect(redactRemote('https://ghp_abc123def456@github.com/owner/repo.git'))
      .toBe('https://***@github.com/owner/repo.git');
  });

  it('leaves a credential-free remote untouched', () => {
    for (const url of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git']) {
      expect(redactRemote(url), url).toBe(url);
    }
  });

  it('redacts every occurrence, so a wrapped error message cannot leak one', () => {
    const message = "fatal: could not read from 'https://tok:en@github.com/a/b' nor 'https://tok:en@github.com/a/b'";
    const redacted = redactRemote(message);
    expect(redacted).not.toContain('tok:en');
    expect(redacted.match(/\/\/\*\*\*@/g)).toHaveLength(2);
  });

  it('never leaves a secret behind for any of the shapes a token can take', () => {
    for (const secret of ['ghp_abc123def456', 's3cret', 'x-access-token:ghp_zzz']) {
      const redacted = redactRemote(`https://${secret}@github.com/owner/repo.git`);
      expect(redacted, secret).not.toContain(secret.split(':').pop()!);
    }
  });
});
