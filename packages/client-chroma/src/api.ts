import { ChromaAgent, ChromaResponse } from './types';
import fetch from 'node-fetch';

export class ChromaApiClient {
  private hostUrl: string;
  private selectedAgent?: ChromaAgent;

  constructor(hostUrl: string) {
    this.hostUrl = hostUrl;
  }

  async initialize(): Promise<void> {
    const agents = await this.getAgents();
    if (agents.length > 0) {
      this.selectedAgent = agents[0];
    } else {
      throw new Error('No Chroma agents available');
    }
  }

  async getAgents(): Promise<ChromaAgent[]> {
    const response = await fetch(`${this.hostUrl}/agents`);
    const data = await response.json() as { agents: ChromaAgent[] };

    return data.agents as ChromaAgent[];
  }

  async sendMessage(text: string): Promise<ChromaResponse[]> {
    if (!this.selectedAgent) {
      throw new Error('No agent selected. Call initialize() first.');
    }

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n--${boundary}--`;

    const response = await fetch(
      `${this.hostUrl}/${this.selectedAgent.id}/message`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body: body
      }
    );

    return await response.json() as ChromaResponse[];
  }

  getSelectedAgent(): ChromaAgent | undefined {
    return this.selectedAgent;
  }
}
