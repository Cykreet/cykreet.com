import { type Actions, fail } from "@sveltejs/kit";
import { RedisSetCache } from "@sylo-digital/kas";
import { validate } from "deep-email-validator";
import { fetchWithRetry } from "../../lib/helpers/fetch-with-retry.js";
import { redisConnection } from "../../lib/helpers/get-redis-connection.js";
import { CLOUDFLARE_SECRET_KEY, MAILGUN_DOMAIN, MAILGUN_KEY, MAILGUN_TO } from "$env/static/private";

const MAILGUN_HOST = "https://api.mailgun.net";
const CLIENT_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

const clientSetCache = new RedisSetCache<string>(redisConnection, "mail-clients");

export const actions = {
	default: async ({ request, getClientAddress }) => {
		const clientKeys = await clientSetCache.keys();
		if (clientKeys.length === 0) {
			// redis sets don't support ttls so we use the first entry in the set
			// as our global expiration date, once it's expired we clear the entire batch
			const expireDate = Date.now() + CLIENT_TTL_MS;
			await clientSetCache.add(expireDate.toString());
		}

		const expireEntry = clientKeys.find((key) => !Number.isNaN(Number(key)) && Number(key) < Date.now());
		if (expireEntry != null) await clientSetCache.clear();

		const formData = await request.formData();
		const name = formData.get("name")?.toString();
		const fromEmail = formData.get("email")?.toString();
		const message = formData.get("message")?.toString();
		if (name == null || fromEmail == null || message == null) return fail(400, { message: "Form data missing" });
		if (name.length > 100 || fromEmail.length > 100 || message.length > 500)
			return fail(400, { message: "Form data does not meet length requirements" });

		const validateAddress = await validate(fromEmail);
		if (validateAddress.valid === false) {
			console.log(`Failed to validate email ${fromEmail}: ${validateAddress.reason}`);
			return fail(400, { message: "The provided email is invalid" });
		}

		// https://vercel.com/docs/edge-network/headers/request-headers#x-forwarded-for
		const requestIp = request.headers.get("x-forwarded-for") ?? getClientAddress();
		const turnstileToken = formData.get("cf-turnstile-response")?.toString();
		if (turnstileToken == null) return fail(400, { message: "Captcha response missing" });
		const tokenResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				response: turnstileToken,
				secret: CLOUDFLARE_SECRET_KEY,
				remoteip: requestIp,
			}),
		});

		const tokenJson = (await tokenResponse.json()) as { success?: boolean };
		if (!tokenResponse.ok || tokenJson?.success !== true) return fail(400, { message: "Failed to validate captcha" });
		if (clientKeys.includes(requestIp)) return fail(429, { message: "Please wait before sending another message" });
		await clientSetCache.add(requestIp);

		const encodedAuth = btoa(`api:${MAILGUN_KEY}`);
		const mailgunUrl = new URL(`${MAILGUN_HOST}/v3/${MAILGUN_DOMAIN}/messages`);
		mailgunUrl.searchParams.set("from", `${name} <${fromEmail}>`);
		mailgunUrl.searchParams.set("to", MAILGUN_TO);
		mailgunUrl.searchParams.set("subject", `Contact form submission from ${name}`);
		mailgunUrl.searchParams.set("text", message);

		const response = await fetchWithRetry(mailgunUrl, {
			method: "POST",
			headers: {
				Authorization: `Basic ${encodedAuth}`,
			},
		});

		if (!response.ok) {
			console.log(`Failed to send email: ${response.status} ${response.statusText}`);
			return fail(500, { message: "Failed to send email, please try again" });
		}

		return { success: true };
	},
} satisfies Actions;

export const prerender = false;
