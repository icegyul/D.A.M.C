import { describe, expect, it, vi, afterEach } from 'vitest';
import { pool, query } from '../src/db/pool.js';

/**
 * Regression cover for the crash observed on `docker compose restart db`:
 *
 *   error: terminating connection due to administrator command
 *   Emitted 'error' event on BoundPool instance
 *
 * pg emits background failures of idle connections on the pool. With no listener
 * attached, Node rethrows and the whole process exits. These tests do not need a
 * live database — they exercise the listener contract that keeps the process alive.
 */
describe('postgres pool resilience', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('attaches an error listener to the pool', () => {
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('survives the administrator-termination error that used to kill the process', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const terminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    expect(() => pool.emit('error', terminated, undefined as never)).not.toThrow();
  });

  it('survives a dropped connection', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => pool.emit('error', reset, undefined as never)).not.toThrow();
  });

  it('logs the failure without leaking the connection string', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }), undefined as never);

    expect(written).toHaveLength(1);
    const entry = JSON.parse(written[0]!);
    expect(entry.source).toBe('db.pool');
    expect(entry.code).toBe('57P01');
    expect(written[0]).not.toContain('postgresql://');
    expect(written[0]!.toLowerCase()).not.toContain('password');
  });

  it('keeps the pool usable after an error, so the next query can reconnect', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    pool.emit('error', new Error('terminating connection due to administrator command'), undefined as never);
    expect(pool.ended).toBe(false);
    expect(typeof query).toBe('function');
  });
});
