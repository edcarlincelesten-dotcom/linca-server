// ============================================
// Linca — Servidor con Stripe Connect
// 95% al vendedor, 5% a Linca automático
// ============================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(cors({
    origin: [
        'http://127.0.0.1:5500',
        'http://localhost:5500',
        'http://127.0.0.1:5500/frontend',
        'http://localhost:5500/frontend',
        'https://linca-marketplace.netlify.app'
    ]
}));

// ── Salud del servidor ────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'Linca server corriendo ✅', version: '2.0.0' });
});

// ── Onboarding: crear enlace para que vendedor conecte su cuenta Stripe ──
// Cuando un vendedor quiere recibir pagos, lo mandamos aquí
app.post('/create-connect-link', async (req, res) => {
    const { userId, userName, userEmail } = req.body;

    try {
        // Crear cuenta Express para el vendedor
        const account = await stripe.accounts.create({
    type: 'express',
    email: userEmail,
    capabilities: {
        transfers: { requested: true },
    },
    business_profile: {
        name: userName,
    },
    metadata: { lincaUserId: String(userId) }
});

        // Crear enlace de onboarding
        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: `${process.env.FRONTEND_URL}/connect-refresh.html`,
            return_url:  `${process.env.FRONTEND_URL}/connect-success.html?accountId=${account.id}&userId=${userId}`,
            type: 'account_onboarding',
        });

        res.json({ url: accountLink.url, accountId: account.id });

    } catch (error) {
        console.error('Error creando cuenta Connect:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── Verificar si una cuenta Connect está lista para recibir pagos ──
app.get('/check-connect-account/:accountId', async (req, res) => {
    try {
        const account = await stripe.accounts.retrieve(req.params.accountId);
        res.json({
            ready: account.charges_enabled && account.payouts_enabled,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Pago por producto individual con Stripe Connect ──────────────
// 95% va al vendedor automáticamente, 5% se queda en Linca
app.post('/create-checkout-session', async (req, res) => {
    const { productName, productPrice, productId, sellerId, sellerStripeId } = req.body;

    if (!productName || !productPrice || productPrice <= 0) {
        return res.status(400).json({ error: 'Datos del producto inválidos' });
    }

    const totalCentavos = Math.round(productPrice * 100);
    const comisionLinca = Math.round(totalCentavos * 0.05); // 5% para Linca

    try {
        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'dop',
                    product_data: { name: productName },
                    unit_amount: totalCentavos,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&product=${encodeURIComponent(productName)}`,
            cancel_url:  `${process.env.FRONTEND_URL}/cancel.html`,
            metadata: {
                productId:    String(productId),
                sellerId:     String(sellerId),
                vendorAmount: String((productPrice * 0.95).toFixed(2)),
                lincaFee:     String((productPrice * 0.05).toFixed(2)),
            },
        };

        // Si el vendedor tiene cuenta Stripe conectada → transferencia automática
        if (sellerStripeId) {
            sessionConfig.payment_intent_data = {
                application_fee_amount: comisionLinca,
                transfer_data: {
                    destination: sellerStripeId,
                },
            };
            console.log(`✅ Pago con Connect: $${productPrice} → Vendedor $${(productPrice*0.95).toFixed(2)} | Linca $${(productPrice*0.05).toFixed(2)}`);
        } else {
            // Si no tiene cuenta Stripe → el dinero llega a Linca (se le paga después)
            console.log(`⚠️ Vendedor sin cuenta Connect — dinero a Linca. Debe pagarle $${(productPrice*0.95).toFixed(2)}`);
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);
        res.json({ url: session.url });

    } catch (error) {
        console.error('Error Stripe Connect:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── Pago carrito completo ─────────────────────
app.post('/create-checkout-cart', async (req, res) => {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'El carrito está vacío' });
    }

    try {
        const line_items = items.map(item => ({
            price_data: {
                currency: 'dop',
                product_data: { name: item.name },
                unit_amount: Math.round(item.price * 100),
            },
            quantity: item.quantity || 1,
        }));

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items,
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&product=Carrito`,
            cancel_url:  `${process.env.FRONTEND_URL}/cancel.html`,
        });

        res.json({ url: session.url });

    } catch (error) {
        console.error('Error carrito:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── Webhook de Stripe ─────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig           = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('💰 Pago completado:', {
            sessionId:    session.id,
            amount:       session.amount_total / 100,
            vendorAmount: session.metadata?.vendorAmount,
            lincaFee:     session.metadata?.lincaFee,
            sellerId:     session.metadata?.sellerId,
        });
    }

    res.json({ received: true });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Linca server v2.0 corriendo en http://localhost:${PORT}`);
    console.log(`   Modo: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? '🟢 PRODUCCIÓN' : '🟡 TEST'}`);
    console.log(`   Stripe Connect: ✅ Activo (5% comisión Linca)\n`);
});