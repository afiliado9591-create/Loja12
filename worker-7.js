// ChatShop API — Cloudflare Worker + D1 (binding DB) + R2 (binding BUCKET)
const enc = new TextEncoder();
const STOP = new Set(["de","da","do","para","com","um","uma","quero","preciso","buscar","procuro","mostrar","mostre","me","por","favor","ate","reais","real","em","no","na","e","ou","o","a"]);
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const E = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const uid = () => crypto.randomUUID().replace(/-/g, "");
const slugify = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: 100000 }, k, 256));
}
const hk = (s, u) => crypto.subtle.importKey("raw", enc.encode(s), { name: "HMAC", hash: "SHA-256" }, false, [u]);
async function sign(o, s) {
  const p = b64(enc.encode(JSON.stringify(o)));
  return p + "." + b64(await crypto.subtle.sign("HMAC", await hk(s, "sign"), enc.encode(p)));
}
async function verify(t, s) {
  const [p, g] = (t || "").split(".");
  if (!p || !g) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hk(s, "verify"), unb64(g), enc.encode(p)))) return null;
    const o = JSON.parse(new TextDecoder().decode(unb64(p)));
    return o.exp > Date.now() / 1e3 ? o : null;
  } catch { return null; }
}
async function session(env, u) {
  const admin = u.email === (env.ADMIN_EMAIL || "").toLowerCase();
  const user = { id: u.id, email: u.email, name: u.name, admin };
  return { token: await sign({ ...user, exp: Math.floor(Date.now() / 1e3) + 2592000 }, env.JWT_SECRET), user };
}
const withFaqs = (ps, fs) => ps.map((p) => ({ ...p, faqs: fs.filter((f) => f.product_id === p.id) }));

// ---- Catálogo: utilitários e importação automática ----
const foldS = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function getSettings(env) {
  const r = (await env.DB.prepare("select key,value from settings").all()).results;
  return Object.fromEntries(r.map((x) => [x.key, x.value]));
}
const setSetting = (env, k, v) => env.DB.prepare("insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value").bind(k, String(v));
async function upsertCatalog(env, items) {
  const st = [];
  for (const it of items) {
    const source = ["mercadolivre", "shein", "shopee", "dridalia"].includes(it.source) ? it.source : null;
    const title = String(it.title || "").trim().slice(0, 200), link = String(it.url || "");
    if (!source || !title || !/^https?:\/\//.test(link)) continue;
    const ext = String(it.external_id || link).slice(0, 300), img = /^https?:\/\//.test(it.image_url || "") ? it.image_url : "";
    const cat = String(it.category || "").slice(0, 80), col = String(it.color || "").slice(0, 40), sn = String(it.store_name || "").slice(0, 80);
    st.push(env.DB.prepare("insert into catalog(id,source,external_id,title,price,old_price,image_url,url,category,color,store_name,search) values(?,?,?,?,?,?,?,?,?,?,?,?) on conflict(source,external_id) do update set title=excluded.title,price=excluded.price,old_price=excluded.old_price,image_url=excluded.image_url,url=excluded.url,category=excluded.category,color=excluded.color,store_name=excluded.store_name,search=excluded.search")
      .bind(uid(), source, ext, title, Number(it.price) || null, Number(it.old_price) || null, img, link, cat, col, sn, foldS(`${title} ${cat} ${col} ${sn}`)));
  }
  if (st.length) await env.DB.batch(st);
  return st.length;
}
// Shopee: API oficial de afiliados (GraphQL assinado)
async function shopeeSearch(S, kw, page) {
  if (!S.shopee_app_id || !S.shopee_secret) E("Cadastre o App ID e o App Secret da Shopee e salve.");
  const query = `{ productOfferV2(keyword: ${JSON.stringify(kw)}, sortType: 2, page: ${page}, limit: 50) { nodes { itemId productName imageUrl priceMin priceMax offerLink shopName } pageInfo { hasNextPage } } }`;
  const payload = JSON.stringify({ query }), ts = Math.floor(Date.now() / 1000);
  const sig = await sha256hex(S.shopee_app_id + ts + payload + S.shopee_secret);
  const r = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `SHA256 Credential=${S.shopee_app_id}, Timestamp=${ts}, Signature=${sig}` },
    body: payload,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) E(`Shopee: ${String(j.errors?.[0]?.message || r.status).slice(0, 200)}`);
  const d = j.data?.productOfferV2;
  const items = (d?.nodes || []).map((p) => ({ source: "shopee", external_id: String(p.itemId), title: p.productName, price: p.priceMin || p.priceMax, image_url: p.imageUrl, url: p.offerLink, category: kw, store_name: p.shopName }));
  return { items, more: !!d?.pageInfo?.hasNextPage };
}
// Mercado Livre: API oficial com token do seu aplicativo
async function mlToken(env, S) {
  if (S.ml_token && Number(S.ml_token_exp) > Date.now() + 60000) return S.ml_token;
  if (!S.ml_client_id || !S.ml_secret) E("Cadastre o Client ID e o Client Secret do Mercado Livre e salve.");
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: S.ml_client_id, client_secret: S.ml_secret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) E(`Mercado Livre recusou as chaves (${r.status}): ${String(j.message || j.error || "").slice(0, 120)}`);
  await env.DB.batch([setSetting(env, "ml_token", j.access_token), setSetting(env, "ml_token_exp", Date.now() + (j.expires_in || 21600) * 1000)]);
  return j.access_token;
}
async function mlSearch(env, S, kw, page) {
  const tk = await mlToken(env, S);
  const r = await fetch(`https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(kw)}&limit=50&offset=${(page - 1) * 50}`, { headers: { authorization: `Bearer ${tk}`, accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) E(`Mercado Livre respondeu ${r.status}: ${String(j.message || j.error || "sem detalhes").slice(0, 160)}`);
  let ex = String(S.ml_params || "").trim();
  if (/^https?:/.test(ex)) ex = ex.split("?")[1] || "";
  ex = ex.replace(/^[?&]+/, "");
  const items = (j.results || []).map((p) => ({
    source: "mercadolivre", external_id: p.id, title: p.title, price: p.price, old_price: p.original_price,
    image_url: String(p.thumbnail || "").replace(/^http:/, "https:").replace(/-I\.(jpg|webp)/, "-O.$1"),
    url: ex ? p.permalink + (p.permalink.includes("?") ? "&" : "?") + ex : p.permalink,
    category: kw, store_name: p.seller?.nickname || "",
  }));
  return { items, more: (j.results || []).length === 50 };
}

async function route(req, env, u, p, m) {
  const DB = env.DB, q = (s, ...a) => DB.prepare(s).bind(...a);
  const body = () => req.json().catch(() => E("JSON inválido"));
  const me = async () => (await verify((req.headers.get("authorization") || "").slice(7), env.JWT_SECRET)) || E("Faça login", 401);
  const own = async (sid, x) => {
    const s = await q("select * from stores where id=?", sid).first();
    if (!s || (s.owner_id !== x.id && !x.admin)) E("Sem permissão", 403);
    return s;
  };
  const [a, b, c] = p;

  if (a === "auth" && m === "POST") {
    const d = await body(), email = String(d.email || "").trim().toLowerCase(), pw = String(d.password || "");
    if (b === "signup") {
      if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 6) E("E-mail ou senha inválidos");
      const salt = b64(crypto.getRandomValues(new Uint8Array(16))), id = uid();
      const name = String(d.name || email.split("@")[0]).slice(0, 80);
      try { await q("insert into users(id,email,name,salt,hash) values(?,?,?,?,?)", id, email, name, salt, await pbkdf2(pw, salt)).run(); }
      catch { E("E-mail já cadastrado"); }
      return J(await session(env, { id, email, name }));
    }
    if (b === "login") {
      const r = await q("select * from users where email=?", email).first();
      if (!r || (await pbkdf2(pw, r.salt)) !== r.hash) E("E-mail ou senha incorretos", 401);
      return J(await session(env, r));
    }
  }

  if (a === "stores" && !b && m === "GET")
    return J((await q("select id,name,slug,description,logo_url from stores where active=1 order by created_at desc limit 12").all()).results);
  if (a === "stores" && b && m === "GET") {
    const s = await q("select id,name,slug,description,whatsapp,logo_url,affiliates_enabled,commission_percent from stores where slug=? and active=1", b).first();
    if (!s) E("Loja não encontrada", 404);
    const ps = (await q("select * from products where store_id=? and active=1 order by created_at desc", s.id).all()).results;
    const fs = (await q("select f.* from faqs f join products p on p.id=f.product_id where p.store_id=? order by f.position", s.id).all()).results;
    return J({ store: s, products: withFaqs(ps, fs) });
  }
  if (a === "my" && b === "stores") {
    const x = await me();
    return J((await q("select * from stores where owner_id=? order by created_at", x.id).all()).results);
  }
  if (a === "stores" && !b && m === "POST") {
    const x = await me(), d = await body(), name = String(d.name || "").trim().slice(0, 80);
    if (name.length < 2) E("Informe o nome da loja");
    const id = uid(), slug = `${slugify(name) || "loja"}-${uid().slice(0, 4)}`;
    await q("insert into stores(id,owner_id,name,slug,whatsapp) values(?,?,?,?,?)", id, x.id, name, slug, String(d.whatsapp || "").replace(/\D/g, "")).run();
    return J({ id, slug });
  }
  if (a === "stores" && b && m === "PUT") {
    const x = await me(), d = await body(); await own(b, x);
    const cp = Number(d.commission_percent);
    if (!(cp >= 0 && cp <= 90)) E("Comissão entre 0 e 90%");
    await q("update stores set name=?,description=?,whatsapp=?,logo_url=?,commission_percent=?,affiliates_enabled=?,active=? where id=?",
      String(d.name || "").slice(0, 80), String(d.description || "").slice(0, 500), String(d.whatsapp || "").replace(/\D/g, ""),
      String(d.logo_url || ""), cp, d.affiliates_enabled ? 1 : 0, d.active ? 1 : 0, b).run();
    return J({ ok: 1 });
  }

  if (a === "my" && b === "products") {
    const x = await me(); await own(c, x);
    const ps = (await q("select * from products where store_id=? order by created_at desc", c).all()).results;
    const fs = (await q("select f.* from faqs f join products p on p.id=f.product_id where p.store_id=? order by f.position", c).all()).results;
    return J(withFaqs(ps, fs));
  }
  if (a === "products" && (m === "POST" || m === "PUT" || m === "DELETE")) {
    const x = await me();
    if (m === "DELETE") {
      const pr = await q("select store_id from products where id=?", b).first(); if (!pr) E("Não encontrado", 404);
      await own(pr.store_id, x); await q("delete from products where id=?", b).run(); return J({ ok: 1 });
    }
    const d = await body(), name = String(d.name || "").trim().slice(0, 120);
    if (!name) E("Informe o nome");
    let pid = b;
    if (m === "POST") await own(d.store_id, x);
    else { const pr = await q("select store_id from products where id=?", b).first(); if (!pr) E("Não encontrado", 404); await own(pr.store_id, x); }
    const img = /^https?:\/\//.test(d.image_url || "") ? d.image_url : "";
    const v = [name, String(d.description || "").slice(0, 2000), Math.max(0, Number(d.price) || 0), img, d.chatbot_enabled ? 1 : 0, d.active ? 1 : 0];
    if (m === "POST") { pid = uid(); await q("insert into products(id,store_id,name,description,price,image_url,chatbot_enabled,active) values(?,?,?,?,?,?,?,?)", pid, d.store_id, ...v).run(); }
    else await q("update products set name=?,description=?,price=?,image_url=?,chatbot_enabled=?,active=? where id=?", ...v, pid).run();
    const fq = (d.faqs || []).filter((f) => f.question?.trim() && f.answer?.trim()).slice(0, 30);
    await DB.batch([q("delete from faqs where product_id=?", pid), ...fq.map((f, i) => q("insert into faqs(id,product_id,question,answer,position) values(?,?,?,?,?)", uid(), pid, f.question.slice(0, 200), f.answer.slice(0, 1000), i))]);
    return J({ id: pid });
  }

  // Pedido: preço e comissão calculados no servidor (igual à função create_order do Postgres)
  if (a === "orders" && !b && m === "POST") {
    const d = await body(), qty = Math.floor(Number(d.qty)), nm = String(d.name || "").trim().slice(0, 120), ph = String(d.phone || "").trim().slice(0, 30);
    if (!(qty >= 1 && qty <= 100) || nm.length < 2 || ph.length < 8) E("Dados inválidos");
    const pr = await q("select p.*,s.commission_percent cp,s.affiliates_enabled ae from products p join stores s on s.id=p.store_id where p.id=? and p.active=1 and s.active=1", d.product_id).first();
    if (!pr) E("Produto indisponível");
    let aff = null;
    if (d.ref && pr.ae) aff = (await q("select id from affiliates where code=? and store_id=? and status='approved'", String(d.ref), pr.store_id).first())?.id || null;
    const t = pr.price * qty, id = uid();
    await q("insert into orders(id,store_id,product_id,product_name,quantity,affiliate_id,customer_name,customer_phone,total,commission) values(?,?,?,?,?,?,?,?,?,?)",
      id, pr.store_id, pr.id, pr.name, qty, aff, nm, ph, t, aff ? Math.round(t * pr.cp) / 100 : 0).run();
    return J({ id });
  }
  if (a === "orders" && b === "store" && m === "GET") {
    const x = await me(); await own(c, x);
    return J((await q("select o.*,a.name aff_name from orders o left join affiliates a on a.id=o.affiliate_id where o.store_id=? order by o.created_at desc", c).all()).results);
  }
  if (a === "orders" && b && m === "PUT") {
    const x = await me(), d = await body(), o = await q("select store_id from orders where id=?", b).first();
    if (!o) E("Não encontrado", 404);
    await own(o.store_id, x);
    const st = ["pending", "confirmed", "cancelled"].includes(d.status) ? d.status : null;
    await q("update orders set status=coalesce(?,status),commission_paid=coalesce(?,commission_paid) where id=?", st, d.commission_paid === undefined ? null : d.commission_paid ? 1 : 0, b).run();
    return J({ ok: 1 });
  }

  if (a === "affiliates" && !b && m === "POST") {
    const x = await me(), d = await body();
    const s = await q("select id from stores where id=? and active=1 and affiliates_enabled=1", d.store_id).first();
    if (!s) E("Loja sem programa de afiliados");
    try { await q("insert into affiliates(id,store_id,user_id,name,email,code) values(?,?,?,?,?,?)", uid(), s.id, x.id, x.name || "", x.email, uid().slice(0, 8)).run(); }
    catch { E("Você já participa deste programa"); }
    return J({ ok: 1 });
  }
  if (a === "my" && b === "affiliate") {
    const x = await me();
    const [mine, stores, orders] = await Promise.all([
      q("select a.*,s.name sname,s.slug,s.commission_percent from affiliates a join stores s on s.id=a.store_id where a.user_id=?", x.id).all(),
      q("select id,name,slug,commission_percent from stores where active=1 and affiliates_enabled=1").all(),
      q("select o.* from orders o join affiliates a on a.id=o.affiliate_id where a.user_id=? order by o.created_at desc", x.id).all(),
    ]);
    return J({ mine: mine.results, stores: stores.results, orders: orders.results });
  }
  if (a === "affiliates" && b === "store" && m === "GET") {
    const x = await me(); await own(c, x);
    return J((await q("select a.*,count(o.id) sales,coalesce(sum(o.commission),0) comm from affiliates a left join orders o on o.affiliate_id=a.id and o.status='confirmed' where a.store_id=? group by a.id order by a.created_at", c).all()).results);
  }
  if (a === "affiliates" && b && m === "PUT") {
    const x = await me(), d = await body(), af = await q("select store_id from affiliates where id=?", b).first();
    if (!af) E("Não encontrado", 404);
    await own(af.store_id, x);
    await q("update affiliates set status=? where id=?", d.status === "blocked" ? "blocked" : "approved", b).run();
    return J({ ok: 1 });
  }

  if (a === "admin" && b === "settings") {
    const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
    if (m === "PUT") {
      const d = await body(), st = [];
      for (const k of ["shopee_app_id", "ml_client_id", "ml_params", "kw_shopee", "kw_ml"]) if (typeof d[k] === "string") st.push(setSetting(env, k, d[k].trim().slice(0, 4000)));
      for (const k of ["shopee_secret", "ml_secret"]) if (typeof d[k] === "string" && d[k].trim()) st.push(setSetting(env, k, d[k].trim()));
      if (d.ml_secret || d.ml_client_id) st.push(setSetting(env, "ml_token_exp", 0));
      if (st.length) await DB.batch(st);
      return J({ ok: 1 });
    }
    const S = await getSettings(env);
    return J({ shopee_app_id: S.shopee_app_id || "", shopee_secret_set: !!S.shopee_secret, ml_client_id: S.ml_client_id || "", ml_secret_set: !!S.ml_secret, ml_params: S.ml_params || "", kw_shopee: S.kw_shopee || "", kw_ml: S.kw_ml || "" });
  }

  if (a === "admin") {
    const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
    if (m === "PUT" && b === "stores") { const d = await body(); await q("update stores set active=? where id=?", d.active ? 1 : 0, c).run(); return J({ ok: 1 }); }
    const stores = (await q("select s.*,u.email owner_email,(select count(*) from affiliates where store_id=s.id) affs,(select count(*) from orders where store_id=s.id and status='confirmed') sales,(select coalesce(sum(total),0) from orders where store_id=s.id and status='confirmed') revenue from stores s join users u on u.id=s.owner_id order by s.created_at desc").all()).results;
    const n = async (t) => (await q(`select count(*) n from ${t}`).first()).n;
    return J({ stores, users: await n("users"), affiliates: await n("affiliates") });
  }

  // ---- Catálogo da IA de buscas ----
  if (a === "catalog") {
    const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (b === "search" && m === "GET") {
      const raw = fold(u.searchParams.get("q")), src = u.searchParams.get("source") || "";
      const lim = 24, off = Math.max(0, Number(u.searchParams.get("offset")) || 0);
      const mp = raw.match(/(?:ate|menos de|abaixo de|maximo)\s*r?\$?\s*(\d+)/);
      const stem = (w) => { w = w.replace(/s$/, ""); return w.length > 4 ? w.slice(0, -1) : w; };
      const toks = raw.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).slice(0, 6).map(stem);
      const where = ["1=1"], args = [];
      if (src) { where.push("source=?"); args.push(src); }
      if (mp) { where.push("price<=?"); args.push(Number(mp[1])); }
      toks.forEach((t) => { where.push("search like ?"); args.push(`%${t}%`); });
      const [rows, tot] = await Promise.all([
        q(`select id,source,title,price,old_price,image_url,url,store_name from catalog where ${where.join(" and ")} order by created_at desc limit ? offset ?`, ...args, lim + 1, off).all(),
        q(`select count(*) n from catalog where ${where.join(" and ")}`, ...args).first(),
      ]);
      return J({ items: rows.results.slice(0, lim), more: rows.results.length > lim, total: tot.n });
    }
    if (b === "stats" && m === "GET") return J((await q("select source, count(*) n from catalog group by source").all()).results);
    if (b === "admin" && m === "GET") {
      const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
      const src = u.searchParams.get("source") || "", t = fold(u.searchParams.get("q")).trim(), off = Math.max(0, Number(u.searchParams.get("offset")) || 0);
      const where = ["1=1"], args = [];
      if (src) { where.push("source=?"); args.push(src); }
      if (t) { where.push("search like ?"); args.push(`%${t}%`); }
      const rows = (await q(`select id,source,external_id,title,price,old_price,image_url,url,category,color from catalog where ${where.join(" and ")} order by created_at desc limit 31 offset ?`, ...args, off).all()).results;
      return J({ items: rows.slice(0, 30), more: rows.length > 30 });
    }
    if (b === "item" && m === "DELETE") {
      const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
      await q("delete from catalog where id=?", c).run();
      return J({ ok: 1 });
    }
    if (b === "auto" && m === "POST") {
      const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
      const d = await body(), kw = String(d.keyword || "").trim().slice(0, 80), page = Math.min(20, Math.max(1, Number(d.page) || 1));
      if (!kw) E("Informe a palavra-chave");
      const S = await getSettings(env);
      const r = d.source === "shopee" ? await shopeeSearch(S, kw, page) : d.source === "mercadolivre" ? await mlSearch(env, S, kw, page) : E("Fonte inválida");
      return J({ imported: await upsertCatalog(env, r.items), more: r.more });
    }
    if (b === "import" && m === "POST") {
      const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
      const d = await body(), items = (Array.isArray(d.items) ? d.items : []).slice(0, 200);
      const n = await upsertCatalog(env, items);
      return J({ imported: n, skipped: items.length - n });
    }
    if (b === "source" && m === "DELETE") {
      const x = await me(); if (!x.admin) E("Acesso restrito ao admin", 403);
      await q("delete from catalog where source=?", c).run();
      return J({ ok: 1 });
    }
  }

  // Imagens no R2
  if (a === "upload" && m === "POST") {
    const x = await me(), ct = req.headers.get("content-type") || "";
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(ct)) E("Envie PNG, JPG, WEBP ou GIF");
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 5 * 1024 * 1024) E("Imagem maior que 5MB");
    const key = `${x.id}/${uid()}`;
    await env.BUCKET.put(key, buf, { httpMetadata: { contentType: ct } });
    return J({ url: `${u.origin}/img/${key}` });
  }
  if (a === "img" && b && c && m === "GET") {
    const o = await env.BUCKET.get(`${b}/${c}`);
    if (!o) return new Response("Não encontrada", { status: 404 });
    return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType || "image/jpeg", "cache-control": "public,max-age=31536000,immutable", etag: o.httpEtag } });
  }
  if (!a) return J({ ok: true, app: "chatshop-api" });
  E("Rota não encontrada", 404);
}

export default {
  async fetch(req, env) {
    const cors = { "access-control-allow-origin": env.ALLOWED_ORIGIN || "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(req.url);
    let r;
    try { r = await route(req, env, u, u.pathname.split("/").filter(Boolean), req.method); }
    catch (e) { console.error(e); r = J({ error: e.status ? e.message : "Erro interno" }, e.status || 500); }
    const h = new Headers(r.headers);
    for (const k in cors) h.set(k, cors[k]);
    return new Response(r.body, { status: r.status, headers: h });
  },
};
