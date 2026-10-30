import type { WorldProvider } from './provider.js';

/**
 * A test message to one node (ADR-003 amendment 2026-10-30) — optional and additive: no existing
 * type changed. The operator's decision of 2026-10-30 ("send can be activated, just not for SDR
 * or anything illegal; mesh is fine"): a mesh radio the operator owns may send one short text,
 * on their press each time, to prove a two-way radio link. Nothing else sends: a receiver
 * (RTL-SDR, AIS, ADS-B) has no such capability and never will.
 *
 * The answer keeps apart what each piece of evidence proves, and never runs them together:
 *
 *   connected      the computer is talking to the radio
 *   accepted       the radio took the packet into its send queue
 *   relayed        another radio was heard repeating it (an implicit acknowledgement): it went
 *                  out over the air and someone heard it
 *   acknowledged   the node it was for said it received it
 *
 * `refused` is a send the radio or the host would not make: no region set, transmit off,
 * too long, too soon after the last.
 */
export interface TestMessageRequest {
  /** The node it goes to (`!a1b2c3d4`); never a broadcast. */
  to: string;
  /** At most 200 bytes of UTF-8. */
  text: string;
  signal: AbortSignal;
}

export interface TestMessageAnswer {
  outcome: 'acknowledged' | 'relayed' | 'accepted' | 'not-acknowledged' | 'refused' | 'not-connected';
  evidence: { connected: boolean; accepted: boolean; relayed: boolean; acknowledged: boolean };
  /** One sentence: what happened and what it proves. */
  message: string;
  /** The packet's id, when one was sent. */
  packetId?: number;
  /** The routing error the radio reported, by name (MAX_RETRANSMIT …), when it reported one. */
  routingError?: string;
  /** When the evidence was last added to. */
  at: string;
}

export interface TestMessageSource {
  sendTestMessage(request: TestMessageRequest): Promise<TestMessageAnswer>;
}

export function isTestMessageSource(provider: WorldProvider): provider is WorldProvider & TestMessageSource {
  return typeof (provider as Partial<TestMessageSource>).sendTestMessage === 'function';
}
