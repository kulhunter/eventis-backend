// server.js - v5.0
// Este robot es robusto. Busca en 100+ fuentes y guarda los resultados
// en una base de datos JSON externa (JSONBin.io) para garantizar que el sitio nunca esté vacío.

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parseStringPromise } = require("xml2js");
const cheerio = require("cheerio");

const app = express();
app.use(cors());

// --- CONFIGURACIÓN DE SECRETOS (se deben añadir en Render) ---
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const SCRAPE_SECRET_KEY = process.env.SCRAPE_SECRET_KEY; // Una clave secreta que tú inventas

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// --- LISTA COMPLETA DE MÁS DE 100 FUENTES ---
const sources = [
    // La lista de 100+ fuentes va aquí (se ha abreviado para no repetir el bloque gigante)
    // Es la misma lista de la versión anterior.
    { name: "El Mostrador Cultura", url: "https://www.elmostrador.cl/cultura/feed/", city: "Nacional", type: "rss" },
    { name: "ChileCultura", url: "https://chilecultura.gob.cl/agendacultural/feed", city: "Nacional", type: "rss" },
    { name: "Santiago Secreto", type: "html", url: "https://santiagosecreto.com/c/panoramas/", city: "Santiago" },
    // ... y el resto de las 100+ fuentes
];

// --- MOTOR DE ANÁLISIS Y EXTRACCIÓN ---
async function getImageFromUrl(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 7000 });
        const $ = cheerio.load(data);
        const imageUrl = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src');
        if (imageUrl && !imageUrl.startsWith('http')) {
            return new URL(imageUrl, url).href;
        }
        return imageUrl;
    } catch (error) { return null; }
}

function analyzeEventContent(title, description) {
    const fullText = (title + ' ' + description).toLowerCase();
    let planType = 'cualquiera';
    let budget = 0;

    const eventKeywords = ['entradas', 'tickets', 'cuándo', 'dónde', 'lugar', 'horario', 'inscríbete', 'reserva', 'invita', 'participa', 'festival', 'concierto', 'exposición', 'obra', 'función'];
    if (!eventKeywords.some(k => fullText.includes(k))) return null;

    const coupleKeywords = ['pareja', 'romántico', 'cena', '2x1'];
    const groupKeywords = ['grupo', 'amigos', 'festival', 'fiesta'];
    const soloKeywords = ['taller', 'charla', 'exposición', 'conferencia'];

    if (coupleKeywords.some(k => fullText.includes(k))) planType = 'pareja';
    else if (groupKeywords.some(k => fullText.includes(k))) planType = 'grupo';
    else if (soloKeywords.some(k => fullText.includes(k))) planType = 'solo';

    const freeKeywords = ['gratis', 'gratuito', 'entrada liberada', 'sin costo'];
    if (!freeKeywords.some(k => fullText.includes(k))) {
        const priceMatch = fullText.match(/\$?(\d{1,3}(?:[.,]\d{3})*)/);
        if (priceMatch) {
            const price = parseInt(priceMatch[1].replace(/[.,]/g, ''));
            const usdPrice = price > 1000 ? price / 1000 : price;
            if (usdPrice <= 10) budget = 10;
            else if (usdPrice <= 20) budget = 20;
            else if (usdPrice <= 30) budget = 30;
            else if (usdPrice <= 40) budget = 40;
            else if (usdPrice <= 50) budget = 50;
            else budget = 51;
        } else { budget = -1; }
    }
    
    return { planType, budget };
}

async function fetchAllEvents() {
    let allEvents = [];
    const fetchPromises = sources.map(async (source) => {
        try {
            const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
            let items = [];
            
            if (source.type === 'rss') {
                const parsedData = await parseStringPromise(data);
                items = (parsedData.rss.channel[0].item || []).map(item => ({
                    title: item.title?.[0] || '', link: item.link?.[0] || '',
                    description: item.description?.[0].replace(/<[^>]*>?/gm, '') || '',
                    pubDate: item.pubDate?.[0] || new Date().toISOString()
                }));
            } else { // html
                const $ = cheerio.load(data);
                $('article').each((i, el) => {
                    const title = $(el).find('h1, h2, h3').first().text().trim();
                    let link = $(el).find('a').first().attr('href');
                    if (link && !link.startsWith('http')) link = new URL(link, source.url).href;
                    const description = $(el).find('p').first().text().trim();
                    if(title && link) items.push({ title, link, description, pubDate: new Date().toISOString() });
                });
            }

            for (const item of items) {
                if (item.title && item.link) {
                    const analysis = analyzeEventContent(item.title, item.description);
                    if (analysis) {
                        const imageUrl = await getImageFromUrl(item.link);
                        allEvents.push({
                            name: item.title, sourceUrl: item.link, city: source.city,
                            date: new Date(item.pubDate).toISOString().slice(0, 10),
                            planType: analysis.planType, budget: analysis.budget, imageUrl: imageUrl
                        });
                    }
                }
            }
        } catch (error) { /* Silently ignore sources that fail */ }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents.filter(e => e.imageUrl); // Solo devuelve eventos con imagen
}

// --- API ENDPOINTS ---
app.get("/", (req, res) => res.send("Motor de Eventis v5 funcionando."));

// Endpoint público: Lee los eventos desde la "bodega" (JSONBin)
app.get("/events", async (req, res) => {
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
        return res.status(500).json({ error: "El servidor no está configurado." });
    }
    try {
        const response = await axios.get(`${JSONBIN_URL}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_API_KEY }
        });
        res.json(response.data.record.events);
    } catch (error) {
        console.error("Error al leer desde JSONBin:", error.message);
        res.status(500).json({ error: "No se pudo obtener la lista de eventos." });
    }
});

// Endpoint protegido: Activa el robot para que busque y guarde nuevos eventos
app.get("/run-scrape", async (req, res) => {
    const { key } = req.query;
    if (key !== SCRAPE_SECRET_KEY) {
        return res.status(401).send("Clave secreta inválida.");
    }
    
    console.log("Scraping activado manualmente...");
    const events = await fetchAllEvents();
    console.log(`Análisis completo. Se encontraron ${events.length} eventos de calidad.`);

    try {
        await axios.put(JSONBIN_URL, { events: events }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_API_KEY,
            }
        });
        console.log("Lista de eventos actualizada en la bodega de JSONBin.");
        res.status(200).send(`Scraping completado. ${events.length} eventos guardados.`);
    } catch (error) {
        console.error("Error al guardar en JSONBin:", error.message);
        res.status(500).send("Error al guardar los eventos.");
    }
});

const listener = app.listen(process.env.PORT, () => {
    console.log("Tu app está escuchando en el puerto " + listener.address().port);
});
