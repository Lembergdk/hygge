// Deterministic synthetic job site for Wave 4 staging acceptance only.
// No real accounts, applications, or external effects: every submission
// succeeds against in-memory responses and sets a synthetic cookie.
const page = (title, body) =>
  new Response(
    `<!doctype html><title>${title}</title><main>${body}</main>`,
    { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } },
  );

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return page("Wave4 Jobs", `
        <h1>Wave4 Jobs</h1>
        <form method="get" action="/listings">
          <label for="q">Search terms</label><input id="q" name="q" type="text">
          <button type="submit">Search</button>
        </form>
        <a href="/listings">Listings</a> <a href="/login">Log in</a>`);
    }
    if (url.pathname === "/listings") {
      return page("Listings", `
        <h1>Listings</h1>
        <a href="/jobs/1">Design job listing for synthetic acceptance testing</a>
        <a href="/jobs/2">Writing job listing for synthetic acceptance testing</a>
        <a href="/jobs/3">Support job listing for synthetic acceptance testing</a>`);
    }
    if (/^\/jobs\/\d+$/.test(url.pathname)) {
      return page("Job detail", `<h1>Synthetic role ${url.pathname}</h1><a href="/apply">Apply</a>`);
    }
    if (url.pathname === "/apply" && request.method === "GET") {
      return page("Apply", `
        <h1>Apply</h1>
        <form method="post" action="/apply/submit">
          <label for="cover">Cover</label><textarea id="cover" name="cover"></textarea>
          <button type="submit">Submit</button>
        </form>`);
    }
    if (url.pathname === "/apply/submit" && request.method === "POST") {
      await request.text().catch(() => "");
      return Response.redirect(new URL("/apply/success", url).href, 303);
    }
    if (url.pathname === "/apply/success") {
      return page("Application received", `<h1>Thanks</h1><a href="/">Application received</a>`);
    }
    if (url.pathname === "/login" && request.method === "GET") {
      return page("Log in", `
        <h1>Log in</h1>
        <form method="post" action="/login">
          <label for="email">Email</label><input id="email" name="email" type="text">
          <label for="pw">Password</label><input id="pw" name="pw" type="password">
          <button type="submit">Log in</button>
        </form>`);
    }
    if (url.pathname === "/login" && request.method === "POST") {
      await request.text().catch(() => "");
      return new Response(null, {
        status: 303,
        headers: { location: "/account", "set-cookie": "wave4_session=synthetic; Path=/; Max-Age=3600; HttpOnly" },
      });
    }
    if (url.pathname === "/account") {
      const signedIn = (request.headers.get("cookie") ?? "").includes("wave4_session=synthetic");
      if (!signedIn) return Response.redirect(new URL("/login", url).href, 303);
      return page("My account", `
        <h1>My account</h1><a href="/account">My account</a> <a href="/">Log out</a>
        <script>localStorage.setItem("wave4","signed-in")</script>`);
    }
    return new Response("not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  },
};
