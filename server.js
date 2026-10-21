import 'dotenv/config';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createTransport } from 'nodemailer';
import pg from 'pg';

const { Pool } = pg;

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, '.data');
const requestsFile = join(dataDirectory, 'requests.jsonl');
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({
	connectionString: databaseUrl,
	connectionTimeoutMillis: 8000,
	idleTimeoutMillis: 30000,
	max: 5
}) : null;
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const bodyLimit = 10 * 1024;
const allowedServices = new Set([
	'ოფისის დასუფთავება',
	'ვიტრაჟებისა და შუშის წმენდა',
	'ხალიჩების წმენდა',
	'გენერალური დასუფთავება',
	'სხვა / კონსულტაცია'
]);
const recentRequests = new Map();
const loginAttempts = new Map();
const sessions = new Map();
let storageQueue = Promise.resolve();
const mailConfig = {
	host: process.env.SMTP_HOST,
	port: Number(process.env.SMTP_PORT || 587),
	secure: process.env.SMTP_SECURE === 'true',
	user: process.env.SMTP_USER,
	password: process.env.SMTP_PASS,
	from: process.env.MAIL_FROM || process.env.SMTP_USER,
	to: process.env.MAIL_TO
};
const emailConfigured = Boolean(mailConfig.host && mailConfig.user && mailConfig.password && mailConfig.from && mailConfig.to);
let emailStatus = emailConfigured ? 'checking' : 'unconfigured';
const mailer = emailConfigured ? createTransport({
	host: mailConfig.host,
	port: mailConfig.port,
	secure: mailConfig.secure,
	auth: { user: mailConfig.user, pass: mailConfig.password },
	connectionTimeout: 8000,
	greetingTimeout: 8000,
	socketTimeout: 10000
}) : null;

function serializeStorage(operation) {
	const result = storageQueue.then(operation, operation);
	storageQueue = result.catch(() => {});
	return result;
}

async function readFileRequests() {
	try {
		const contents = await readFile(requestsFile, 'utf8');
		return contents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line)]; } catch { return []; }
		});
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

function requestFromRow(row) {
	return {
		id: row.id,
		createdAt: new Date(row.created_at).toISOString(),
		status: row.status,
		name: row.name,
		phone: row.phone,
		service: row.service,
		details: row.details
	};
}

async function readRequests() {
	if (!pool) return readFileRequests();
	const result = await pool.query('SELECT id, created_at, status, name, phone, service, details FROM inquiries ORDER BY created_at DESC');
	return result.rows.map(requestFromRow);
}

async function insertRequest(request) {
	await pool.query(
		'INSERT INTO inquiries (id, created_at, status, name, phone, service, details) VALUES ($1, $2, $3, $4, $5, $6, $7)',
		[request.id, request.createdAt, request.status, request.name, request.phone, request.service, request.details]
	);
}

async function writeRequests(requests) {
	await mkdir(dataDirectory, { recursive: true });
	const temporaryFile = `${requestsFile}.${randomUUID()}.tmp`;
	await writeFile(temporaryFile, requests.map((request) => JSON.stringify(request)).join('\n') + (requests.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
	await rename(temporaryFile, requestsFile);
}

async function initializeDatabase() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS inquiries (
			id TEXT PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL,
			status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'completed')),
			name TEXT NOT NULL,
			phone TEXT NOT NULL,
			service TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT ''
		)
	`);
	await pool.query('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const migration = await client.query('SELECT 1 FROM app_migrations WHERE name = $1', ['jsonl-requests-v1']);
		if (migration.rowCount === 0) {
			const legacyRequests = await readFileRequests();
			for (const request of legacyRequests) {
				if (!request.id || !request.createdAt || !request.name || !request.phone || !request.service) continue;
				await client.query(
					'INSERT INTO inquiries (id, created_at, status, name, phone, service, details) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
					[request.id, request.createdAt, request.status || 'new', request.name, request.phone, request.service, request.details || '']
				);
			}
			await client.query('INSERT INTO app_migrations (name) VALUES ($1)', ['jsonl-requests-v1']);
			console.log(`Imported ${legacyRequests.length} legacy requests into PostgreSQL; original JSONL file was kept.`);
		}
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

function configuredAdmin() {
	const productionUsernameConfigured = process.env.NODE_ENV !== 'production'
		|| (Boolean(process.env.ADMIN_USERNAME) && adminUsername !== 'admin');
	return adminPassword.length >= 15 && productionUsernameConfigured;
}

function sameSecret(actual, expected) {
	const actualHash = createHash('sha256').update(actual).digest();
	const expectedHash = createHash('sha256').update(expected).digest();
	return timingSafeEqual(actualHash, expectedHash);
}

function sessionFor(request) {
	const token = request.headers.cookie?.match(/(?:^|;\s*)admin_session=([a-f\d]+)/i)?.[1];
	if (!token) return false;
	const expiresAt = sessions.get(token);
	if (!expiresAt || expiresAt <= Date.now()) {
		sessions.delete(token);
		return false;
	}
	return true;
}

function cookieHeader(token, maxAge) {
	const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
	return `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function isAllowedAdminOrigin(request) {
	const originHeader = request.headers.origin;
	const host = request.headers.host;
	if (!originHeader || !host) return process.env.NODE_ENV !== 'production';
	try {
		const origin = new URL(originHeader);
		const protocol = process.env.NODE_ENV === 'production' || request.socket.encrypted ? 'https:' : 'http:';
		return origin.host.toLowerCase() === host.toLowerCase() && origin.protocol === protocol;
	} catch {
		return false;
	}
}

function rateLimitedLogin(ip) {
	const now = Date.now();
	const windowMs = 15 * 60 * 1000;
	const attempt = loginAttempts.get(ip);
	if (!attempt || now - attempt.startedAt >= windowMs) {
		loginAttempts.set(ip, { startedAt: now, count: 1 });
		return false;
	}
	attempt.count += 1;
	return attempt.count > 8;
}

function sendInquiryEmail(inquiry) {
	if (!mailer) return;
	void mailer.sendMail({
		from: mailConfig.from,
		to: mailConfig.to,
		subject: `ახალი მოთხოვნა — ${inquiry.service}`,
		text: [
			'შემოვიდა ახალი მოთხოვნა City Management Group-ის საიტიდან.',
			`კლიენტი: ${inquiry.name}`,
			`ტელეფონი: ${inquiry.phone}`,
			`მომსახურება: ${inquiry.service}`,
			`დეტალები: ${inquiry.details || 'მითითებული არ არის'}`,
			`მოთხოვნის ID: ${inquiry.id}`
		].join('\n')
	}).then(() => {
		emailStatus = 'ready';
	}).catch((error) => {
		emailStatus = 'error';
		console.error(`Email notification failed (${error.code || error.name}).`);
	});
}

function sendJson(response, status, body, headers = {}) {
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...headers
	});
	response.end(JSON.stringify(body));
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = '';
		let bodySize = 0;
		let tooLarge = false;
		request.setEncoding('utf8');
		request.on('data', (chunk) => {
			if (tooLarge) return;
			bodySize += Buffer.byteLength(chunk, 'utf8');
			if (bodySize > bodyLimit) {
				tooLarge = true;
				body = '';
				return;
			}
			body += chunk;
		});
		request.on('end', () => {
			if (tooLarge) reject(Object.assign(new Error('მოთხოვნა ძალიან დიდია.'), { status: 413 }));
			else resolve(body);
		});
		request.on('error', reject);
	});
}

function validateRequest(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return { error: 'მოთხოვნის ფორმატი არასწორია.' };
	}

	const name = typeof payload.name === 'string' ? payload.name.trim() : '';
	const phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
	const service = typeof payload.service === 'string' ? payload.service.trim() : '';
	const details = typeof payload.details === 'string' ? payload.details.trim() : '';
	const phoneDigits = phone.replace(/\D/g, '');

	if (name.length < 2 || name.length > 120) return { error: 'მიუთითეთ სახელი ან კომპანიის დასახელება.' };
	if (phoneDigits.length < 7 || phoneDigits.length > 15) return { error: 'შეამოწმეთ ტელეფონის ნომერი.' };
	if (!allowedServices.has(service)) return { error: 'აირჩიეთ მომსახურება სიიდან.' };
	if (details.length > 1500) return { error: 'დამატებითი ინფორმაცია ძალიან გრძელია.' };

	return { value: { name, phone, service, details } };
}

function isRateLimited(ip) {
	const now = Date.now();
	const windowMs = 10 * 60 * 1000;
	const maxRequests = 8;
	const current = recentRequests.get(ip);
	if (!current || now - current.startedAt >= windowMs) {
		recentRequests.set(ip, { startedAt: now, count: 1 });
		return false;
	}
	current.count += 1;
	return current.count > maxRequests;
}

async function serveStatic(pathname, response) {
	const files = {
		'/': ['index.html', 'text/html; charset=utf-8'],
		'/index.html': ['index.html', 'text/html; charset=utf-8'],
		'/pricing': ['pricing.html', 'text/html; charset=utf-8'],
		'/pricing.html': ['pricing.html', 'text/html; charset=utf-8'],
		'/admin': ['admin.html', 'text/html; charset=utf-8'],
		'/admin.html': ['admin.html', 'text/html; charset=utf-8'],
		'/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
		'/658387698_1547267307403600_8734942271708288651_n.jpg': [
			'658387698_1547267307403600_8734942271708288651_n.jpg',
			'image/jpeg'
		],
		'/260749047_6916016825089971_8964684175723472677_n.png': [
			'260749047_6916016825089971_8964684175723472677_n.png',
			'image/png'
		]
	};
	const file = files[pathname];
	if (!file) return false;

	try {
		const contents = await readFile(join(root, file[0]));
		const securityHeaders = {
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'DENY',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
			'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
			'Content-Security-Policy': "default-src 'self'; img-src 'self' https://images.unsplash.com data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
			'Cache-Control': file[1].startsWith('text/html') ? 'no-store' : 'public, max-age=3600'
		};
		if (process.env.NODE_ENV === 'production') {
			securityHeaders['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
		}
		response.writeHead(200, {
			'Content-Type': file[1],
			...securityHeaders
		});
		response.end(contents);
	} catch {
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('ფაილი ვერ მოიძებნა.');
	}
	return true;
}

async function handleAdmin(request, response, url) {
	if (['POST', 'PATCH', 'DELETE'].includes(request.method) && !isAllowedAdminOrigin(request)) {
		return sendJson(response, 403, { error: 'უსაფრთხოების შემოწმებამ მოთხოვნა უარყო.' });
	}

	if (url.pathname === '/api/admin/session' && request.method === 'GET') {
		if (!configuredAdmin()) {
			return sendJson(response, 503, { error: 'ადმინისტრატორი ჯერ არ არის კონფიგურირებული. დაამატეთ ADMIN_PASSWORD .env ფაილში.' });
		}
		return sendJson(response, 200, { authenticated: sessionFor(request), emailConfigured, emailStatus });
	}

	if (url.pathname === '/api/admin/login' && request.method === 'POST') {
		if (!configuredAdmin()) {
			return sendJson(response, 503, { error: 'ადმინისტრატორი ჯერ არ არის კონფიგურირებული. დაამატეთ ADMIN_PASSWORD .env ფაილში.' });
		}
		const ip = request.socket.remoteAddress || 'unknown';
		if (rateLimitedLogin(ip)) return sendJson(response, 429, { error: 'ძალიან ბევრი მცდელობაა. სცადეთ 15 წუთში.' });
		let payload;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			return sendJson(response, 400, { error: 'შესვლის მონაცემები არასწორია.' });
		}
		const username = typeof payload?.username === 'string' ? payload.username : '';
		const password = typeof payload?.password === 'string' ? payload.password : '';
		if (!sameSecret(username, adminUsername) || !sameSecret(password, adminPassword)) {
			return sendJson(response, 401, { error: 'მომხმარებელი ან პაროლი არასწორია.' });
		}

		loginAttempts.delete(ip);
		const now = Date.now();
		for (const [token, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(token);
		const token = randomBytes(32).toString('hex');
		const maxAge = 8 * 60 * 60;
		sessions.set(token, now + maxAge * 1000);
		return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieHeader(token, maxAge) });
	}

	if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
		const token = request.headers.cookie?.match(/(?:^|;\s*)admin_session=([a-f\d]+)/i)?.[1];
		if (token) sessions.delete(token);
		return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
	}

	if (!sessionFor(request)) return sendJson(response, 401, { error: 'ადმინისტრატორის ავტორიზაცია საჭიროა.' });

	if (url.pathname === '/api/admin/requests' && request.method === 'GET') {
		try {
			const allRequests = (await readRequests()).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
			const status = url.searchParams.get('status') || '';
			const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('ka-GE');
			const filtered = allRequests.filter((item) => {
				const statusMatch = !status || (item.status || 'new') === status;
				const searchMatch = !query || [item.name, item.phone, item.service, item.details].some((value) => String(value || '').toLocaleLowerCase('ka-GE').includes(query));
				return statusMatch && searchMatch;
			});
			const stats = { new: 0, in_progress: 0, completed: 0 };
			for (const item of allRequests) {
				const currentStatus = item.status || 'new';
				if (currentStatus in stats) stats[currentStatus] += 1;
			}
			return sendJson(response, 200, { requests: filtered, stats, emailConfigured, emailStatus });
		} catch (error) {
			console.error('Failed to read inquiries:', error.message);
			return sendJson(response, 500, { error: 'მოთხოვნების წაკითხვა ვერ მოხერხდა.' });
		}
	}

	const requestMatch = url.pathname.match(/^\/api\/admin\/requests\/([a-f\d-]{36})$/i);
	if (requestMatch && request.method === 'PATCH') {
		let payload;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			return sendJson(response, 400, { error: 'სტატუსის მონაცემი არასწორია.' });
		}
		if (!['new', 'in_progress', 'completed'].includes(payload?.status)) {
			return sendJson(response, 400, { error: 'სტატუსი სიიდან უნდა აირჩიოთ.' });
		}
		try {
			const updated = await serializeStorage(async () => {
				if (pool) {
					const result = await pool.query(
						'UPDATE inquiries SET status = $1 WHERE id = $2 RETURNING id, created_at, status, name, phone, service, details',
						[payload.status, requestMatch[1]]
					);
					return result.rows[0] ? requestFromRow(result.rows[0]) : null;
				}
				const requests = await readRequests();
				const item = requests.find((entry) => entry.id === requestMatch[1]);
				if (!item) return null;
				item.status = payload.status;
				await writeRequests(requests);
				return item;
			});
			if (!updated) return sendJson(response, 404, { error: 'მოთხოვნა ვერ მოიძებნა.' });
			return sendJson(response, 200, { ok: true, request: updated });
		} catch (error) {
			console.error('Failed to update inquiry:', error.message);
			return sendJson(response, 500, { error: 'სტატუსის შენახვა ვერ მოხერხდა.' });
		}
	}

	if (requestMatch && request.method === 'DELETE') {
		try {
			const deleted = await serializeStorage(async () => {
				if (pool) {
					const result = await pool.query('DELETE FROM inquiries WHERE id = $1', [requestMatch[1]]);
					return result.rowCount > 0;
				}
				const requests = await readRequests();
				const remaining = requests.filter((entry) => entry.id !== requestMatch[1]);
				if (remaining.length === requests.length) return false;
				await writeRequests(remaining);
				return true;
			});
			if (!deleted) return sendJson(response, 404, { error: 'მოთხოვნა ვერ მოიძებნა.' });
			return sendJson(response, 200, { ok: true });
		} catch (error) {
			console.error('Failed to delete inquiry:', error.message);
			return sendJson(response, 500, { error: 'მოთხოვნის წაშლა ვერ მოხერხდა.' });
		}
	}

	return sendJson(response, 404, { error: 'ადმინისტრაციის API ვერ მოიძებნა.' });
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://localhost');

	if (url.pathname === '/api/health' && request.method === 'GET') {
		return sendJson(response, 200, { status: 'ok' });
	}
	if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, response, url);

	if (url.pathname === '/api/requests') {
		if (request.method !== 'POST') {
			return sendJson(response, 405, { error: 'მეთოდი დაშვებული არ არის.' }, { Allow: 'POST' });
		}
		if (!request.headers['content-type']?.includes('application/json')) {
			return sendJson(response, 415, { error: 'მოთხოვნა JSON ფორმატში უნდა გაიგზავნოს.' });
		}

		const ip = request.socket.remoteAddress || 'unknown';
		if (isRateLimited(ip)) {
			return sendJson(response, 429, { error: 'ძალიან ბევრი მოთხოვნაა. სცადეთ მოგვიანებით.' });
		}

		try {
			const rawBody = await readRequestBody(request);
			let payload;
			try {
				payload = JSON.parse(rawBody);
			} catch {
				return sendJson(response, 400, { error: 'მოთხოვნის JSON ფორმატი არასწორია.' });
			}

			const validation = validateRequest(payload);
			if (validation.error) return sendJson(response, 400, { error: validation.error });

			const inquiry = {
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				status: 'new',
				...validation.value
			};
			await serializeStorage(async () => {
				if (pool) await insertRequest(inquiry);
				else {
					await mkdir(dataDirectory, { recursive: true });
					await appendFile(requestsFile, `${JSON.stringify(inquiry)}\n`, { encoding: 'utf8', mode: 0o600 });
				}
			});
			sendInquiryEmail(inquiry);
			return sendJson(response, 201, { ok: true, id: inquiry.id, emailQueued: Boolean(mailer) });
		} catch (error) {
			if (response.destroyed) return;
			if (error.status) return sendJson(response, error.status, { error: error.message });
			console.error('Failed to save inquiry:', error);
			return sendJson(response, 500, { error: 'მოთხოვნის შენახვა ვერ მოხერხდა. სცადეთ მოგვიანებით.' });
		}
	}
	if ((url.pathname === '/admin' || url.pathname === '/admin.html') && request.method === 'GET') {
		if (!await serveStatic('/admin', response)) return sendJson(response, 404, { error: 'გვერდი ვერ მოიძებნა.' });
		return;
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return sendJson(response, 405, { error: 'მეთოდი დაშვებული არ არის.' }, { Allow: 'GET, HEAD' });
	}
	if (!await serveStatic(url.pathname, response)) {
		return sendJson(response, 404, { error: 'გვერდი ვერ მოიძებნა.' });
	}
});

async function startServer() {
	if (process.env.NODE_ENV === 'production' && !pool) {
		console.error('Production startup requires DATABASE_URL so inquiries are stored durably.');
		process.exitCode = 1;
		return;
	}
	if (process.env.NODE_ENV === 'production' && !configuredAdmin()) {
		console.error('Production startup requires a custom ADMIN_USERNAME and an ADMIN_PASSWORD of at least 15 characters.');
		process.exitCode = 1;
		return;
	}
	if (pool) {
		try {
			await initializeDatabase();
		} catch (error) {
			console.error(`Database initialization failed (${error.code || error.name}). Check DATABASE_URL and database availability.`);
			process.exitCode = 1;
			await pool.end();
			return;
		}
	}

	const host = process.env.HOST || '0.0.0.0';
	server.listen(port, host, () => {
		console.log(`City Management Group server running on port ${port} (${host}).`);
		if (mailer) {
			void mailer.verify().then(() => {
				emailStatus = 'ready';
				console.log('SMTP connection verified.');
			}).catch((error) => {
				emailStatus = 'error';
				console.error(`SMTP verification failed (${error.code || error.name}).`);
			});
		}
	});
}

void startServer();
