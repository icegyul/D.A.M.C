import { GenericExportConnector } from './generic-export-connector.js';

/**
 * Adapter boundary for Claude.
 * It intentionally does not automate web login, cookie extraction, or unofficial scraping.
 * Current working path: official data export/import or an explicitly supported official connection.
 */
export class ClaudeConnector extends GenericExportConnector {
  constructor() { super('claude'); }
}
