import { describe, expect, it } from 'vitest';
import { ChatGPTConnector } from '../src/connectors/chatgpt-connector.js';
import { ClaudeConnector } from '../src/connectors/claude-connector.js';
import { isConnectable } from '../src/services/connector-connection-service.js';

/**
 * The capability model is the honesty contract: every field here is a claim
 * the UI repeats verbatim. Real provider limitations (docs/COMMON_MEMORY_LAYER.md
 * §"Provider capability model") mean the true value for every AI-provider
 * capability today is fixed — these tests pin that down so a future change
 * cannot silently start claiming liveSync/contextPush/oauth without a real
 * feature landing to justify it.
 */
describe('provider capability model', () => {
  for (const [label, connector] of [['ChatGPT', new ChatGPTConnector()], ['Claude', new ClaudeConnector()]] as const) {
    describe(label, () => {
      const caps = connector.capabilities();

      it('can be imported and manually synced through DAMC\'s own pipeline', () => {
        expect(caps.import).toBe(true);
        expect(caps.manualSync).toBe(true);
      });

      it('never claims autoSync, liveSync, contextPush or oauth — no such official API exists for consumer chat history', () => {
        expect(caps.autoSync).toBe(false);
        expect(caps.liveSync).toBe(false);
        expect(caps.contextPush).toBe(false);
        expect(caps.oauth).toBe(false);
      });

      it('can produce a Context Pack for this provider to read', () => {
        expect(caps.contextExport).toBe(true);
      });

      it('never claims to read account data directly', () => {
        expect(caps.readAccountData).toBe(false);
      });
    });
  }
});

describe('isConnectable', () => {
  it('allows only providers DAMC actually has a local pipeline for', () => {
    expect(isConnectable('chatgpt')).toBe(true);
    expect(isConnectable('claude')).toBe(true);
  });

  it('refuses providers with no real integration, rather than silently accepting anything', () => {
    for (const bad of ['gemini', 'local-llm', 'openai-api', '', 'CHATGPT', 'anthropic']) {
      expect(isConnectable(bad), bad).toBe(false);
    }
  });
});
