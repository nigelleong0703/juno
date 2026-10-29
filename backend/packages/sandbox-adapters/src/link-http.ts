/**
 * One HTTP request over a computer link stream: how computerd (and the LIVE tests) talk to the in-computer Spaces gateway,
 * which publishes no port. The caller opens the stream (`provider.gatewayStream`).
 */
import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { streamConnector } from './link-hub.js';

export interface LinkResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text(): string;
  json(): unknown;
}

export function httpOverStream(open: () => Promise<Duplex>, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<LinkResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: 'computer', path, method: init.method ?? 'GET', headers: init.headers ?? {}, createConnection: streamConnector(open) as never }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (piece: Buffer) => parts.push(piece));
      res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: () => body, json: () => JSON.parse(body) as unknown });
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}
