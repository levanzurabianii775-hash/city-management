import 'dotenv/config';

const baseUrl = 'http://127.0.0.1:3000';
const origin = { Origin: baseUrl };
const login = await fetch(`${baseUrl}/api/admin/login`, {
	method: 'POST',
	headers: { ...origin, 'Content-Type': 'application/json' },
	body: JSON.stringify({
		username: process.env.ADMIN_USERNAME || 'admin',
		password: process.env.ADMIN_PASSWORD
	})
});

if (!login.ok) {
	console.log(`Admin login failed (${login.status}).`);
	process.exitCode = 1;
} else {
	const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
	const requests = await fetch(`${baseUrl}/api/admin/requests`, { headers: { Cookie: cookie } });
	const logout = await fetch(`${baseUrl}/api/admin/logout`, {
		method: 'POST',
		headers: { ...origin, Cookie: cookie }
	});
	console.log(JSON.stringify({ login: login.status, protectedList: requests.status, logout: logout.status }));
}