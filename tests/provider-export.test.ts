import { describe, expect, it } from 'vitest';
import { parseChatGPTExport, parseClaudeExport, detectProvider } from '../src/connectors/provider-export-parsers.js';

describe('provider export parsers', () => {
  it('reconstructs a ChatGPT mapping path', () => {
    const out = parseChatGPTExport([{ id:'c1', title:'Earthus', current_node:'b', mapping:{
      root:{id:'root',parent:null,message:null},
      a:{id:'a',parent:'root',message:{id:'a',author:{role:'user'},content:{parts:['hello']}}},
      b:{id:'b',parent:'a',message:{id:'b',author:{role:'assistant'},content:{parts:['world']}}}
    }}]);
    expect(out[0]?.messages.map(m => m.content)).toEqual(['hello','world']);
  });

  it('normalizes Claude human/assistant messages and content blocks', () => {
    const out = parseClaudeExport([{ uuid:'c1', name:'Test', chat_messages:[
      {uuid:'m1',sender:'human',content:[{type:'text',text:'Hello'}]},
      {uuid:'m2',sender:'assistant',content:[{type:'text',text:'Hi'}]}
    ]}]);
    expect(out[0]?.messages.map(m => [m.role,m.content])).toEqual([['user','Hello'],['assistant','Hi']]);
  });
});

/**
 * detectProvider exists only for the watch folder, where nobody is present to
 * pick a provider. It must recognize both real shapes and refuse to guess on
 * anything else — a wrong guess would run a file through the wrong parser.
 */
describe('detectProvider', () => {
  it('recognizes a ChatGPT export by its mapping graph', () => {
    expect(detectProvider([{ id: 'c1', mapping: { root: {} } }])).toBe('chatgpt');
  });

  it('recognizes a ChatGPT export wrapped in a conversations array', () => {
    expect(detectProvider({ conversations: [{ id: 'c1', mapping: { root: {} } }] })).toBe('chatgpt');
  });

  it('recognizes a Claude export by its chat_messages array', () => {
    expect(detectProvider([{ uuid: 'c1', chat_messages: [] }])).toBe('claude');
  });

  it('refuses to guess on an unrecognized shape', () => {
    expect(detectProvider([{ id: 'c1', notes: 'hello' }])).toBeNull();
    expect(detectProvider({})).toBeNull();
    expect(detectProvider([])).toBeNull();
    expect(detectProvider(null)).toBeNull();
    expect(detectProvider('drop table memories')).toBeNull();
  });

  it('does not mistake a Claude export for a ChatGPT one or vice versa', () => {
    expect(detectProvider([{ uuid: 'c1', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi' }] }])).toBe('claude');
    expect(detectProvider([{ id: 'c1', current_node: 'b', mapping: { b: {} } }])).toBe('chatgpt');
  });
});
