/**
 * Outbound mail, over an SMTP server the operator already has.
 *
 * Cloudflare's send_email binding exists because a Worker cannot open port 25: the runtime has no
 * raw sockets to a mail server and the egress addresses are shared, so Email Routing brokers it
 * and restricts the destination to a verified address. **None of that applies here.** bastion is
 * an ordinary process on the operator's own host, so it dials SMTP directly, and the destination
 * restriction that exists to protect a shared IP reputation is replaced by the tenant's own egress
 * allow list, which the operator sets.
 *
 * The message is passed through byte for byte. bastion does not parse or re-encode MIME, because a
 * re-encode invalidates a DKIM signature and the failure shows up as silent spam classification
 * rather than as an error anybody sees.
 */

import type { Context } from '../context';
import { BastionError } from '../errors';

export interface EmailMessage {
	from: string;
	to: string;
	/** the raw rfc822 message, passed through unchanged */
	raw: string;
}

export interface EmailStore {
	id(): string;
	send(message: EmailMessage): Promise<void>;
	isReachable(): Promise<boolean>;
}

/** an address bastion will put in a MAIL FROM or RCPT TO, checked before it reaches the wire */
const ADDRESS = /^[^\s<>@",;:\\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Refuses an address that could break out of the SMTP command it is interpolated into.
 *
 * SMTP is a line protocol, so a CR or LF inside an address is command injection: a crafted
 * `from` could append `RCPT TO` lines and turn one tenant's mail into an open relay. The regex
 * excludes both along with every other character that is not legal in an addr-spec.
 */
export function assertAddress(value: string, field: string): void {
	if (!ADDRESS.test(value)) {
		throw new BastionError('usage', `${field} is not an address bastion will send to`, {
			next: null
		});
	}
}

export interface SmtpOptions {
	host: string;
	port?: number;
	user?: string;
	password?: string;
	/** starttls on 587 and implicit tls on 465, which is the split every server uses */
	secure?: boolean;
	/** destinations this deployment may send to; empty means the egress policy is the only gate */
	allow?: string[];
}

/** matches a destination against the allow list, where an entry may be a domain or an address */
export function allowsDestination(to: string, allow: string[] | undefined): boolean {
	if (allow === undefined || allow.length === 0) return true;
	const domain = to.slice(to.indexOf('@') + 1).toLowerCase();
	return allow.some((entry) => {
		const want = entry.toLowerCase();
		return want === to.toLowerCase() || want === domain || want === `@${domain}`;
	});
}

/**
 * The SMTP conversation bastion speaks, as a list of lines to send and the code each expects.
 *
 * Built as data rather than as a sequence of awaits so the gate lane can assert the whole exchange
 * without opening a socket, which is the same seam every other driver here takes.
 */
export function smtpScript(
	message: EmailMessage,
	options: SmtpOptions,
	hostname = 'bastion'
): { send: string; expect: number }[] {
	const steps: { send: string; expect: number }[] = [{ send: `EHLO ${hostname}`, expect: 250 }];
	if (options.user !== undefined && options.password !== undefined) {
		// AUTH PLAIN carries the credential in one line, so it is never sent before the transport
		// is encrypted; `sendMail` refuses a plaintext hop with a password set
		const token = btoa(`\0${options.user}\0${options.password}`);
		steps.push({ send: `AUTH PLAIN ${token}`, expect: 235 });
	}
	steps.push({ send: `MAIL FROM:<${message.from}>`, expect: 250 });
	steps.push({ send: `RCPT TO:<${message.to}>`, expect: 250 });
	steps.push({ send: 'DATA', expect: 354 });
	// a lone dot on its own line ends DATA, so one inside the body is doubled per rfc 5321
	steps.push({ send: `${message.raw.replace(/\r?\n\./g, '\r\n..')}\r\n.`, expect: 250 });
	steps.push({ send: 'QUIT', expect: 221 });
	return steps;
}

export interface SmtpTransport {
	/** opens the conversation and answers each line's reply code in order */
	exchange(steps: { send: string; expect: number }[]): Promise<number[]>;
	reachable(): Promise<boolean>;
}

export function smtpEmail(
	ctx: Context,
	options: SmtpOptions,
	transport: SmtpTransport
): EmailStore {
	void ctx;
	return {
		id: () => 'smtp',
		isReachable: () => transport.reachable(),
		send: async (message) => {
			assertAddress(message.from, 'from');
			assertAddress(message.to, 'to');
			if (!allowsDestination(message.to, options.allow)) {
				throw new BastionError(
					'driver-refused',
					`this deployment does not send to ${message.to}`,
					{ next: 'bastion config where drivers.email' }
				);
			}
			if (options.password !== undefined && options.secure !== true && options.port !== 587) {
				throw new BastionError(
					'driver-refused',
					'refusing to send a password over a plaintext smtp hop; set secure or use 587',
					{ next: 'bastion config where drivers.email' }
				);
			}
			const steps = smtpScript(message, options);
			const codes = await transport.exchange(steps);
			for (const [index, step] of steps.entries()) {
				const code = codes[index];
				if (code === undefined || code !== step.expect) {
					throw new BastionError(
						'driver-refused',
						`the mail server answered ${code ?? 'nothing'} where ${step.expect} was expected`,
						{ retryable: code !== undefined && code >= 400 && code < 500 }
					);
				}
			}
		}
	};
}

/** records what would have been sent, for a drill and for the gate lane */
export function recordingEmail(): EmailStore & { sent: EmailMessage[] } {
	const sent: EmailMessage[] = [];
	return {
		sent,
		id: () => 'recording',
		isReachable: () => Promise.resolve(true),
		send: async (message) => {
			assertAddress(message.from, 'from');
			assertAddress(message.to, 'to');
			sent.push(message);
		}
	};
}
