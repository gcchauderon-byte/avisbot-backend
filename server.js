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

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Google Business connecté !</h2>
        <p>AvisBot est maintenant actif pour votre établissement.</p>
        <p>Vous recevrez une notification Telegram à chaque réponse publiée.</p>
      </body></html>
    `);
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
        await postResponse(client, review, response);
        await notifyClient(client, review, response);
        results.push({ client: client.email, review_id: review.reviewId, status: 'published' });
      }
    } catch (err) {
      console.error(`Error processing ${client.email}:`, err.message);
      results.push({ client: client.email, status: 'error', error: err.message });
    }
  }

  res.json({ processed: results.length, results });
});

// ─── 5. GET REVIEWS depuis Google Business ────────────────────────────────
async function getNewReviews(client) {
  oauth2Client.setCredentials({
    access_token: client.google_access_token,
    refresh_token: client.google_refresh_token,
  });
  
  const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth: oauth2Client });
  const accounts = await mybusiness.accounts.list();
  const accountName = accounts.data.accounts[0].name;

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
    from: 'AvisBot <contact@avisbot.io>',
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

// ─── 9. EMAIL DE BIENVENUE ────────────────────────────────────────────────
async function sendWelcomeEmail(email, plan) {
  const { data } = await supabase.from('clients').select('id').eq('email', email).single();
  const clientId = data?.id;
  const onboardingUrl = `https://avisbot-backend.onrender.com/oauth/start?clientId=${clientId}`;

  await resend.emails.send({
    from: 'AvisBot <contact@avisbot.io>',
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

// ─── UTILS ────────────────────────────────────────────────────────────────
function getPlanName(priceId) {
  const plans = {
    'price_1T9v0AQonIcKOoU1VtDqxfpJ': 'Starter',
    'price_1T9v0BQonIcKOoU14Eoan3K5': 'Pro',
    'price_1T9v0LQonIcKOoU1I0ZuvEhr': 'Business'
  };
  return plans[priceId] || 'Starter';
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', version: '1.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AvisBot backend running on port ${PORT}`));

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
