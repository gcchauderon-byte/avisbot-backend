const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.2,
  environment: process.env.NODE_ENV || 'production'
});

const express = require('express');
const { google } = require('googleapis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://avisbot.io');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Rate limiting (process-reviews)
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const last = rateMap.get(ip) || 0;
  if (now - last < 60000) return res.status(429).json({ error: 'Rate limit' });
  rateMap.set(ip, now);
  next();
}

app.use(express.json());
app.use(express.raw({ type: 'application/json' })); // pour Stripe webhook

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI // https://avisbot-backend.onrender.com/oauth/callback
);

// ─── 1. STRIPE WEBHOOK ─────────────────────────────────────────────────────
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'customer.subscription.created') {
    const sub = event.data.object;
    const customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
    const plan = getPlanName(sub.items.data[0].price.id);

    // Créer client dans Supabase
    await supabase.from('clients').insert({
      email: customerEmail,
      stripe_customer_id: sub.customer,
      plan: plan,
      status: 'onboarding',
      created_at: new Date().toISOString()
    });

    // Envoyer email de bienvenue avec lien onboarding
    await sendWelcomeEmail(customerEmail, plan);
    console.log(`Nouveau client: ${customerEmail} - Plan: ${plan}`);
  }

  res.json({ received: true });
});

// ─── 2. GOOGLE OAUTH — Initier la connexion ────────────────────────────────
app.get('/oauth/start', (req, res) => {
  const { clientId } = req.query; // ID client AvisBot
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/business.manage'
    ],
    state: clientId, // on passe l'ID client pour le récupérer au callback
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// ─── 3. GOOGLE OAUTH — Callback ───────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, state: clientId } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Stocker les tokens dans Supabase
    await supabase.from('clients').update({
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token,
      google_token_expiry: tokens.expiry_date,
      status: 'active'
    }).eq('id', clientId);

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AvisBot — Connexion réussie</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 20px; padding: 40px 32px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    .icon { width: 80px; height: 80px; background: #dcfce7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 36px; animation: pop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
    @keyframes pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
    h1 { font-size: 22px; font-weight: 700; color: #111; margin-bottom: 10px; }
    .subtitle { color: #6b7280; font-size: 15px; line-height: 1.6; margin-bottom: 32px; }
    .steps { text-align: left; background: #f8fafc; border-radius: 12px; padding: 20px; margin-bottom: 28px; }
    .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .step:last-child { margin-bottom: 0; }
    .step-num { width: 28px; height: 28px; background: #2563eb; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
    .step-text { font-size: 14px; color: #374151; line-height: 1.5; }
    .step-text strong { color: #111; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: #eff6ff; color: #2563eb; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; }
    .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Google Business connecté !</h1>
    <p class="subtitle">AvisBot est maintenant actif pour votre établissement. Vos prochains avis Google seront répondus automatiquement.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text"><strong>Scan automatique</strong> — AvisBot vérifie vos nouveaux avis toutes les 4h</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text"><strong>Réponse générée</strong> — Une réponse personnalisée adaptée à la note et au contenu</div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text"><strong>Publication directe</strong> — La réponse est publiée sur Google sans aucune action de votre part</div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text"><strong>Notification email</strong> — Vous recevez un résumé à chaque réponse publiée</div>
      </div>
    </div>
    <div class="badge">
      <div class="dot"></div>
      AvisBot actif
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Erreur de connexion Google. Réessayez.');
  }
});

// ─── 4. PROCESS REVIEWS — Appelé par Make.com (cron 4h) ───────────────────
app.post('/process-reviews', rateLimit, async (req, res) => {
  const { authorization } = req.headers;
  if (authorization !== `Bearer ${process.env.INTERNAL_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'active');

  const results = [];
  for (const client of clients) {
    try {
      const reviews = await getNewReviews(client);
      for (const review of reviews) {
        const response = await generateResponse(review, client);
        
        // ── HUMAN-IN-THE-LOOP (Google guide recommendation) ──────────────
        // Si preview_mode activé : envoyer email de prévisualisation et attendre
        // Sinon : publier directement (comportement par défaut)
        if (client.preview_mode) {
          await sendPreviewEmail(client, review, response);
          await supabase.from('review_log').insert({
            client_id: client.id,
            review_id: review.reviewId,
            review_text: review.comment,
            response_text: response,
            status: 'pending_approval',
            created_at: new Date().toISOString()
          });
          results.push({ client: client.email, review_id: review.reviewId, status: 'pending_approval' });
        } else {
          await postResponse(client, review, response);
          await notifyClient(client, review, response);
          results.push({ client: client.email, review_id: review.reviewId, status: 'published' });
        }
      }
    } catch (err) {
      console.error(`Error processing ${client.email}:`, err.message);
      results.push({ client: client.email, status: 'error', error: err.message });
    }
  }

  res.json({ processed: results.length, results });
});

// ─── 5. GET REVIEWS depuis Google Business ────────────────────────────────
// Cache accounts par client pour éviter les quota exceeded (TTL 30 min)
const accountsCache = new Map();

async function getNewReviews(client) {
  oauth2Client.setCredentials({
    access_token: client.google_access_token,
    refresh_token: client.google_refresh_token,
  });

  let accountName;
  const cacheKey = client.id;
  const cached = accountsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    accountName = cached.accountName;
  } else {
    const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
    let attempts = 0;
    while (attempts < 3) {
      try {
        const accounts = await mybusiness.accounts.list();
        accountName = accounts.data.accounts[0].name;
        accountsCache.set(cacheKey, { accountName, ts: Date.now() });
        break;
      } catch (err) {
        if (err.code === 429 || (err.message && err.message.includes('Quota'))) {
          attempts++;
          await new Promise(r => setTimeout(r, attempts * 10000));
        } else throw err;
      }
    }
    if (!accountName) throw new Error('Google API quota exceeded after retries');
  }

  const locations = google.mybusinessbusinessinformation({ version: 'v1', auth: oauth2Client });
  const locs = await locations.locations.list({ parent: accountName });
  const locationName = locs.data.locations[0].name;

  const reviews = google.mybusiness({ version: 'v4', auth: oauth2Client });
  const result = await reviews.accounts.locations.reviews.list({
    parent: locationName,
    pageSize: 10
  });

  // Filtrer reviews sans réponse
  return (result.data.reviews || []).filter(r => !r.reviewReply);
}

// ─── 6. GÉNÉRER RÉPONSE via Anthropic (Claude Haiku) ─────────────────────
async function generateResponse(review, client) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const rating = review.starRating;
  const text = review.comment || '(Avis sans commentaire)';
  const tone = client.tone || 'professionnel et chaleureux';
  const restaurantName = client.restaurant_name || 'notre établissement';

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Tu es le gérant de "${restaurantName}". Réponds à cet avis Google en ${tone}.
      
Note: ${rating}/5 étoiles
Avis: "${text}"

Règles:
- 2-4 phrases maximum
- Remercie si positif, reconnais le problème si négatif
- Ne jamais être défensif
- Signe avec le prénom du gérant si fourni
- Ton: ${tone}

Réponds directement, sans explication.`
    }]
  });

  return message.content[0].text;
}

// ─── 7. PUBLIER RÉPONSE sur Google Business ───────────────────────────────
async function postResponse(client, review, responseText) {
  oauth2Client.setCredentials({
    access_token: client.google_access_token,
    refresh_token: client.google_refresh_token,
  });

  const reviews = google.mybusiness({ version: 'v4', auth: oauth2Client });
  await reviews.accounts.locations.reviews.updateReply({
    name: review.name,
    requestBody: { comment: responseText }
  });
}

// ─── 8. NOTIFIER LE CLIENT ────────────────────────────────────────────────
async function notifyClient(client, review, response) {
  const stars = '⭐'.repeat(parseInt(review.starRating) || 3);
  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'AvisBot <onboarding@resend.dev>',
    to: client.email,
    subject: `${stars} Nouvel avis répondu automatiquement`,
    html: `
      <h3>AvisBot a répondu à un nouvel avis</h3>
      <p><strong>Note :</strong> ${stars}</p>
      <p><strong>Avis :</strong> ${review.comment || '(sans commentaire)'}</p>
      <p><strong>Réponse publiée :</strong></p>
      <blockquote style="border-left:3px solid #2563eb;padding-left:16px;color:#555">
        ${response}
      </blockquote>
      <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p>
    `
  });
}

// ─── PREVIEW EMAIL (human-in-the-loop) ───────────────────────────────────
async function sendPreviewEmail(client, review, response) {
  const stars = '⭐'.repeat(parseInt(review.starRating) || 3);
  const approveUrl = `https://avisbot-backend.onrender.com/approve-response?clientId=${client.id}&reviewId=${review.reviewId}`;
  
  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'AvisBot <onboarding@resend.dev>',
    to: client.email,
    subject: `${stars} AvisBot va répondre dans 1h — validez ou stoppez`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h3>AvisBot a rédigé une réponse pour vous</h3>
        <p><strong>Note reçue :</strong> ${stars}</p>
        <p><strong>Avis :</strong> ${review.comment || '(sans commentaire)'}</p>
        <hr/>
        <p><strong>Réponse prévue dans 1h :</strong></p>
        <blockquote style="border-left:3px solid #2563eb;padding-left:16px;color:#333;font-style:italic">
          ${response}
        </blockquote>
        <p>
          <a href="${approveUrl}&action=approve" 
             style="background:#16a34a;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;margin-right:12px">
            ✅ Publier maintenant
          </a>
          <a href="${approveUrl}&action=stop" 
             style="background:#dc2626;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">
            ❌ Ne pas publier
          </a>
        </p>
        <p style="color:#888;font-size:12px">Sans action de votre part, la réponse sera publiée automatiquement dans 1h.<br>AvisBot — avisbot.io</p>
      </div>
    `
  });
}

// ─── 9. EMAIL DE BIENVENUE ────────────────────────────────────────────────
async function sendWelcomeEmail(email, plan) {
  const { data } = await supabase.from('clients').select('id').eq('email', email).single();
  const clientId = data?.id;
  const onboardingUrl = `https://avisbot-backend.onrender.com/oauth/start?clientId=${clientId}`;

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'AvisBot <onboarding@resend.dev>',
    to: email,
    subject: '🎉 Bienvenue sur AvisBot — 1 étape pour démarrer',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>Bienvenue sur AvisBot 🤖</h2>
        <p>Votre essai gratuit 14 jours est activé (plan <strong>${plan}</strong>).</p>
        <p>Une seule étape pour démarrer :</p>
        <a href="${onboardingUrl}" 
           style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
          Connecter mon Google Business →
        </a>
        <p>Après ça, AvisBot répond automatiquement à tous vos avis Google.<br>
        Vous recevrez un email à chaque réponse publiée.</p>
        <p>Des questions ? Répondez à cet email.</p>
        <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p>
      </div>
    `
  });
}

// ─── ONBOARDING EMAIL SEQUENCE (J+1, J+3, J+7, J+14, J+30) ──────────────
async function sendOnboardingSequenceEmail(client, day) {
  const sequences = {
    1: {
      subject: '📊 Votre premier rapport AvisBot',
      html: (c) => `<div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>Bonjour,</h2>
        <p>AvisBot surveille activement votre fiche Google depuis hier.</p>
        <p>Dès qu'un nouvel avis est déposé, une réponse professionnelle sera publiée automatiquement.</p>
        <p><strong>Conseil J+1 :</strong> Activez le mode preview si vous souhaitez valider les réponses avant publication.</p>
        <p>Bonne journée !</p><p style="color:#888;font-size:12px">AvisBot — avisbot.io</p></div>`
    },
    3: {
      subject: '✅ AvisBot fonctionne — voici comment ça marche',
      html: (c) => `<div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>3 jours avec AvisBot 🚀</h2>
        <p>Voici ce qu'AvisBot fait pour vous en ce moment :</p>
        <ul>
          <li>🔍 Surveillance de vos avis Google en temps réel</li>
          <li>🤖 Génération de réponses personnalisées avec l'IA</li>
          <li>📤 Publication automatique sur votre fiche Google</li>
          <li>📧 Notification email après chaque réponse</li>
        </ul>
        <p>Vous n'avez rien à faire. AvisBot s'occupe de tout.</p>
        <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p></div>`
    },
    7: {
      subject: '📈 Bilan semaine 1 avec AvisBot',
      html: (c) => `<div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>1 semaine avec AvisBot ✨</h2>
        <p>Une semaine s'est écoulée depuis votre démarrage.</p>
        <p>Saviez-vous que les fiches Google avec un taux de réponse >90% obtiennent <strong>+34% de clics</strong> en moyenne ?</p>
        <p>AvisBot vous garantit ce taux — automatiquement.</p>
        <p>Votre essai gratuit se termine dans 7 jours. Pour continuer :</p>
        <a href="https://avisbot.io/#pricing" style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
          Voir les plans →
        </a>
        <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p></div>`
    },
    14: {
      subject: '⏰ 14 jours — votre essai gratuit se termine bientôt',
      html: (c) => `<div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>Votre essai gratuit se termine dans 14 jours ⚡</h2>
        <p>AvisBot a répondu à vos avis pendant 2 semaines. Pas une seule réponse manquée.</p>
        <p>Pour continuer à protéger votre réputation Google :</p>
        <a href="https://buy.stripe.com/5kQdRbbb29ybg2vgt94ko0b" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
          Activer mon plan Solo 79€/mois →
        </a>
        <p>Des questions ? Répondez à cet email, je vous réponds sous 24h.</p>
        <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p></div>`
    },
    30: {
      subject: '🏆 1 mois avec AvisBot — merci !',
      html: (c) => `<div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2>1 mois ! 🎉</h2>
        <p>Merci de faire confiance à AvisBot.</p>
        <p>En 30 jours, AvisBot a :</p>
        <ul>
          <li>Surveillé votre fiche Google 24h/24</li>
          <li>Répondu à chaque avis reçu</li>
          <li>Maintenu votre taux de réponse à 100%</li>
        </ul>
        <p>Vous êtes satisfait ? <a href="mailto:contact@avisbot.io">Partagez votre avis</a> — ça nous aide énormément.</p>
        <p style="color:#888;font-size:12px">AvisBot — avisbot.io</p></div>`
    }
  };

  const seq = sequences[day];
  if (!seq) return;
  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'AvisBot <onboarding@resend.dev>',
    to: client.email,
    subject: seq.subject,
    html: seq.html(client)
  });
  console.log(`Onboarding email J+${day} envoyé à ${client.email}`);
}

// Cron onboarding sequence — vérifie tous les jours à 10h UTC
const cron = require('node-cron');
cron.schedule('0 10 * * *', async () => {
  try {
    const { data: clients } = await supabase.from('clients').select('*').eq('status', 'active');
    if (!clients) return;
    for (const client of clients) {
      const created = new Date(client.created_at);
      const now = new Date();
      const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      if ([1, 3, 7, 14, 30].includes(daysDiff)) {
        await sendOnboardingSequenceEmail(client, daysDiff);
      }
    }
  } catch (err) {
    console.error('Onboarding sequence error:', err.message);
  }
});

// ─── UTILS ────────────────────────────────────────────────────────────────
function getPlanName(priceId) {
  const plans = {
    'price_1T9v0AQonIcKOoU1VtDqxfpJ': 'Starter',
    'price_1T9v0BQonIcKOoU14Eoan3K5': 'Pro',
    'price_1T9v0LQonIcKOoU1I0ZuvEhr': 'Business'
  };
  return plans[priceId] || 'Starter';
}

// ─── APPROVE / REJECT PREVIEW RESPONSE ───────────────────────────────────
app.get('/approve-response', async (req, res) => {
  const { clientId, reviewId, action } = req.query;
  if (!clientId || !reviewId || !['approve', 'stop'].includes(action)) {
    return res.status(400).send('<h2>❌ Paramètres invalides.</h2>');
  }
  try {
    const { data: pending, error } = await supabase
      .from('review_log')
      .select('*')
      .eq('review_id', reviewId)
      .eq('client_id', clientId)
      .eq('status', 'pending_approval')
      .single();

    if (error || !pending) {
      return res.status(404).send('<h2>⚠️ Avis introuvable ou déjà traité.</h2>');
    }

    const { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (action === 'approve') {
      // Publier sur Google Business
      const fakeReview = { reviewId: pending.review_id, name: pending.review_name || reviewId };
      await postResponse(client, fakeReview, pending.response_text);
      await supabase.from('review_log').update({ status: 'published' }).eq('review_id', reviewId).eq('client_id', clientId);
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fdf4">
<div style="font-size:60px">✅</div>
<h2 style="color:#16a34a">Réponse publiée sur Google !</h2>
<p style="color:#555">La réponse a été publiée automatiquement sur votre fiche Google Business.</p>
</body></html>`);
    } else {
      await supabase.from('review_log').update({ status: 'rejected' }).eq('review_id', reviewId).eq('client_id', clientId);
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff7ed">
<div style="font-size:60px">⏸️</div>
<h2 style="color:#ea580c">Réponse annulée.</h2>
<p style="color:#555">La réponse ne sera pas publiée. Vous pouvez répondre manuellement depuis Google Business.</p>
</body></html>`);
    }
  } catch (err) {
    console.error('approve-response error:', err);
    res.status(500).send('<h2>Erreur serveur.</h2>');
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', version: '1.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AvisBot backend running on port ${PORT}`);

  // ── CRON INTERNE — remplace Make.com complètement ──────────────────────
  // Toutes les 4h : scanner les avis + répondre automatiquement
  try {
    const cron = require('node-cron');
    cron.schedule('0 */4 * * *', async () => {
      console.log('[CRON] process-reviews démarré', new Date().toISOString());
      try {
        const { data: clients } = await supabase
          .from('clients').select('*').eq('status', 'active');
        for (const client of (clients || [])) {
          try {
            const reviews = await getNewReviews(client);
            for (const review of reviews) {
              const response = await generateResponse(review, client);
              if (client.preview_mode) {
                await sendPreviewEmail(client, review, response);
              } else {
                await postResponse(client, review, response);
                await notifyClient(client, review, response);
              }
              console.log(`[CRON] Répondu avis pour ${client.email}`);
            }
          } catch (err) {
            console.error(`[CRON] Erreur ${client.email}:`, err.message);
            Sentry.captureException(err);
          }
        }
      } catch (err) {
        console.error('[CRON] Erreur globale:', err.message);
        Sentry.captureException(err);
      }
    });
    console.log('[CRON] Programmé toutes les 4h ✅');
  } catch (err) {
    console.warn('[CRON] node-cron non disponible, utiliser Make.com comme fallback');
  }
});

// AUTO-MIGRATION — exécuté au démarrage
async function runMigrations() {
  console.log('Running migrations...');
  
  // Utiliser l'API SQL de Supabase via pg direct n'est pas disponible
  // On crée les tables via l'API REST si elles n'existent pas
  const { error: e1 } = await supabase.rpc('create_tables_if_not_exists').catch(() => ({ error: 'rpc_not_found' }));
  
  // Fallback: vérifier et insérer via upsert pour déclencher la création
  const { error } = await supabase
    .from('clients')
    .select('id')
    .limit(1);
    
  if (error && error.code === 'PGRST205') {
    console.log('Tables missing — please run SQL schema in Supabase dashboard');
    console.log('SQL file: supabase_schema.sql');
  } else {
    console.log('Database tables OK ✅');
  }
}

runMigrations().catch(console.error);

// ─── ENDPOINT MAKE.COM — Générer une réponse pour 1 avis ──────────────────
app.post('/generate-response', async (req, res) => {
  const { authorization } = req.headers;
  if (authorization !== `Bearer ${process.env.INTERNAL_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { review, rating, restaurant, tone, manager } = req.body;
  
  if (!review && !rating) {
    return res.status(400).json({ error: 'review or rating required' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Tu es le gérant de "${restaurant || 'notre établissement'}". Réponds à cet avis Google en ${tone || 'professionnel et chaleureux'}.
        
Note: ${rating || '?'}/5 étoiles
Avis: "${review || '(Avis sans commentaire)'}"

Règles:
- 2-4 phrases maximum
- Remercie si positif, reconnais le problème si négatif
- Ne jamais être défensif
${manager ? `- Signe avec: ${manager}` : ''}

Réponds directement, sans explication.`
      }]
    });

    const response = message.content[0].text;
    res.json({ response, restaurant, rating });
    
  } catch (err) {
    Sentry.captureException(err);
    console.error('Generate response error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ONBOARDING WIZARD ────────────────────────────────────────────────────
const path = require('path');

app.get('/onboarding', (req, res) => {
  res.sendFile(path.join(__dirname, 'onboarding.html'));
});

app.post('/onboarding/save', async (req, res) => {
  const { clientId } = req.query;
  const { restaurantName, managerName, tone, previewMode } = req.body;
  
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { error } = await supabase.from('clients').update({
    restaurant_name: restaurantName,
    manager_name: managerName,
    tone: tone || 'professionnel et chaleureux',
    preview_mode: previewMode || false
  }).eq('id', clientId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── RENDER DEPLOY WEBHOOK → NOTIFICATION AUTO ───────────────────────────
app.post('/render-webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;
    const serviceName = event.data?.service?.name || 'avisbot-backend';
    const deployStatus = event.data?.deploy?.status || event.type;
    
    // Notifier uniquement en cas d'échec
    if (deployStatus === 'build_failed' || deployStatus === 'deploy_failed' || 
        event.type === 'deploy_failed') {
      
      const commitMsg = event.data?.deploy?.commit?.message || 'unknown';
      const deployId = event.data?.deploy?.id || '?';
      
      // Envoyer notification Telegram via bot
      const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
      const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
      
      if (BOT_TOKEN && CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: `🚨 *Render Deploy Failed*\n\nService: ${serviceName}\nDeploy: \`${deployId}\`\nCommit: ${commitMsg}\n\nJanet analyse et patch automatiquement...`,
            parse_mode: 'Markdown'
          })
        });
      }
      
      // Log Sentry
      Sentry.captureMessage(`Deploy failed: ${deployId} - ${commitMsg}`, 'error');
      console.error(`[WEBHOOK] Deploy failed: ${deployId}`);
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
