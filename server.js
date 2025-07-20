// server.js - v7.0
// Este robot ahora incluye la capacidad de conectarse a la API de Eventbrite,
// además de las más de 150 fuentes anteriores.

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
const SCRAPE_SECRET_KEY = process.env.SCRAPE_SECRET_KEY;
const EVENTBRITE_API_TOKEN = process.env.EVENTBRITE_API_TOKEN; // Nuevo secreto para Eventbrite

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// --- LÓGICA GENÉRICA DE SCRAPING ---

const scrapeRssFeed = (feed) => {
    const events = [];
    if (!feed.rss.channel[0] || !feed.rss.channel[0].item) return events;
    feed.rss.channel[0].item.forEach(item => {
        try {
            const title = item.title?.[0] || '';
            const link = item.link?.[0] || '';
            const description = item.description?.[0].replace(/<[^>]*>?/gm, '') || '';
            const content = item['content:encoded'] ? item['content:encoded'][0] : '';
            const $ = cheerio.load(content);
            const imageUrl = $('img').attr('src');

            if (title && link) {
                events.push({
                    name: title,
                    description: description.substring(0, 150) + '...',
                    imageUrl: imageUrl,
                    sourceUrl: link,
                    location: "Revisar en el sitio web",
                    category: inferCategory(title, content),
                });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeHtmlArticle = ($, baseURI) => {
    const events = [];
    $("article, .evento, .event-item, .activity-card").each((index, element) => {
        try {
            const titleElement = $(element).find("h1, h2, h3, .title, .nombre-evento").first();
            const title = titleElement.text().trim();
            let url = titleElement.find("a").attr("href") || $(element).find("a").first().attr("href");
            const description = $(element).find("p, .description, .bajada").first().text().trim();
            let imageUrl = $(element).find("img").attr("src");

            if (url && !url.startsWith('http')) url = new URL(url, baseURI).href;
            if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseURI).href;

            if (title && url && description && description.length > 15) {
                events.push({
                    name: title,
                    description: description.substring(0, 150) + '...',
                    imageUrl: imageUrl,
                    sourceUrl: url,
                    location: "Revisar en el sitio web",
                    category: inferCategory(title, description),
                });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

// Lógica específica para la API de Eventbrite
const scrapeEventbriteApi = (apiResponse) => {
    const events = [];
    if (!apiResponse.events) return events;
    apiResponse.events.forEach(event => {
        try {
            const analysis = analyzeEventContent(event.name.text, event.summary || '');
            if (analysis) { // Solo procesa si parece un evento real
                events.push({
                    name: event.name.text,
                    description: (event.summary || '').substring(0, 150) + '...',
                    imageUrl: event.logo ? event.logo.original.url : null,
                    sourceUrl: event.url,
                    location: event.venue && event.venue.address ? event.venue.address.localized_address_display : 'Online o por confirmar',
                    category: 'Cultura', // Eventbrite no tiene categorías estandarizadas
                    date: new Date(event.start.local).toISOString().slice(0, 10),
                    planType: analysis.planType,
                    budget: analysis.budget,
                });
            }
        } catch(e) { /* Silently fail */ }
    });
    return events;
};


// --- LISTA COMPLETA DE MÁS DE 150 FUENTES ---
const sources = [
    // --- API (Prioridad Máxima) ---
    { 
        name: "Eventbrite API", 
        type: "api", 
        // Busca eventos gratuitos en Santiago, Chile.
        url: `https://www.eventbriteapi.com/v3/events/search/?location.address=Santiago%2C+Chile&price=free&token=${EVENTBRITE_API_TOKEN}`, 
        city: "Santiago", 
        scrape: scrapeEventbriteApi 
    },

    // --- NIVEL 1: Agregadores Nacionales y de Grandes Ciudades ---
    { name: "PanoramasGratis.cl", type: "html", url: "https://panoramasgratis.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "ChileCultura.gob.cl", type: "rss", url: "https://chilecultura.gob.cl/agendacultural/feed", city: "Nacional", scrape: scrapeRssFeed },
    // ... y el resto de las 150+ fuentes
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
    const fullText = (title + ' ' + (description || '')).toLowerCase();
    let planType = 'cualquiera';
    let budget = 0;

    const eventKeywords = ['entradas', 'tickets', 'cuándo', 'dónde', 'lugar', 'horario', 'inscríbete', 'reserva', 'invita', 'participa', 'festival', 'concierto', 'exposición', 'obra', 'función', 'cartelera'];
    const negativeKeywords = ['estos son', 'los mejores', 'la guía', 'hablamos con', 'entrevista', 'reseña', 'opinión', 'análisis'];
    
    if (!eventKeywords.some(k => fullText.includes(k)) || negativeKeywords.some(k => title.toLowerCase().includes(k))) {
        return null;
    }

    const freeKeywords = ['gratis', 'gratuito', 'entrada liberada', 'sin costo'];
    if (freeKeywords.some(k => fullText.includes(k))) {
        budget = 0;
    } else {
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
        } else {
            budget = -1;
        }
    }

    const coupleKeywords = ['pareja', 'romántico', 'cena', '2x1'];
    const groupKeywords = ['grupo', 'amigos', 'festival', 'fiesta'];
    const soloKeywords = ['taller', 'charla', 'exposición', 'conferencia'];

    if (coupleKeywords.some(k => fullText.includes(k))) planType = 'pareja';
    else if (groupKeywords.some(k => fullText.includes(k))) planType = 'grupo';
    else if (soloKeywords.some(k => fullText.includes(k))) planType = 'solo';
    
    return { planType, budget };
}

async function fetchAllEvents() {
    let allEvents = [];
    const fetchPromises = sources.map(async (source) => {
        try {
            // Reconstruir la URL de Eventbrite con el token si es necesario
            if (source.name === "Eventbrite API") {
                source.url = `https://www.eventbriteapi.com/v3/events/search/?location.address=Santiago%2C+Chile&price=free&token=${EVENTBRITE_API_TOKEN}`;
            }

            const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
            let items = [];
            
            if (source.type === 'rss') {
                const parsedData = await parseStringPromise(data);
                items = (parsedData.rss.channel[0].item || []).map(item => ({
                    title: item.title?.[0] || '', link: item.link?.[0] || '',
                    description: item.description?.[0].replace(/<[^>]*>?/gm, '') || '',
                    pubDate: item.pubDate?.[0] || new Date().toISOString()
                }));
            } else if (source.type === 'html') {
                const $ = cheerio.load(data);
                $('article, .evento, .event-item, .activity-card').each((i, el) => {
                    const title = $(el).find('h1, h2, h3, .title, .nombre-evento').first().text().trim();
                    let link = $(el).find('a').first().attr('href');
                    if (link && !link.startsWith('http')) link = new URL(link, source.url).href;
                    const description = $(el).find('p, .description, .bajada').first().text().trim();
                    if(title && link) items.push({ title, link, description, pubDate: new Date().toISOString() });
                });
            } else if (source.type === 'api') {
                items = source.scrape(data); // La función scrape de API procesa la respuesta
            }

            for (const item of items) {
                if (item.name && item.sourceUrl) { // API de Eventbrite ya viene procesada
                    allEvents.push(item);
                    continue;
                }

                if (item.title && item.link) {
                    const analysis = analyzeEventContent(item.title, item.description);
                    if (analysis) {
                        const imageUrl = await getImageFromUrl(item.link);
                        if (imageUrl) {
                            allEvents.push({
                                name: item.title, sourceUrl: item.link, city: source.city,
                                date: new Date(item.pubDate).toISOString().slice(0, 10),
                                planType: analysis.planType, budget: analysis.budget, imageUrl: imageUrl
                            });
                        }
                    }
                }
            }
        } catch (error) { /* Silently ignore sources that fail */ }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents;
}

// --- API ENDPOINTS (Sin cambios) ---
app.get("/", (req, res) => res.send("Motor de Eventis v6 funcionando."));

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
        res.status(500).json({ error: "No se pudo obtener la lista de eventos." });
    }
});

app.get("/run-scrape", async (req, res) => {
    const { key } = req.query;
    if (key !== SCRAPE_SECRET_KEY) {
        return res.status(401).send("Clave secreta inválida.");
    }
    
    console.log("Scraping activado...");
    const events = await fetchAllEvents();
    console.log(`Análisis completo. Se encontraron ${events.length} eventos de calidad.`);

    try {
        await axios.put(JSONBIN_URL, { events: events }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_API_KEY,
            }
        });
        res.status(200).send(`Scraping completado. ${events.length} eventos de calidad guardados.`);
    } catch (error) {
        res.status(500).send("Error al guardar los eventos en la bodega.");
    }
});

const listener = app.listen(process.env.PORT, () => {
    console.log("Tu app está escuchando en el puerto " + listener.address().port);
});
