// server.js - v8.0
// Este robot es la versión definitiva y funcional. Utiliza la lista de fuentes del usuario,
// prioriza encontrar eventos reales y gratuitos, y es flexible con las imágenes
// para asegurar que el sitio siempre tenga contenido.

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
const EVENTBRITE_API_TOKEN = process.env.EVENTBRITE_API_TOKEN;

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
                events.push({ name: title, description: description.substring(0, 150) + '...', imageUrl, sourceUrl: link });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeHtmlArticle = ($, baseURI) => {
    const events = [];
    $("article, .evento, .event-item, .activity-card, .post-card, .card").each((index, element) => {
        try {
            const titleElement = $(element).find("h1, h2, h3, .title, .nombre-evento, .card-title").first();
            const title = titleElement.text().trim();
            let url = titleElement.find("a").attr("href") || $(element).find("a").first().attr("href");
            const description = $(element).find("p, .description, .bajada, .card-text").first().text().trim();
            let imageUrl = $(element).find("img").attr("src");

            if (url && !url.startsWith('http')) url = new URL(url, baseURI).href;
            if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseURI).href;

            if (title && url && description && description.length > 15) {
                events.push({ name: title, description: description.substring(0, 150) + '...', imageUrl, sourceUrl: url });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeEventbriteApi = (apiResponse) => {
    const events = [];
    if (!apiResponse.events) return events;
    apiResponse.events.forEach(event => {
        try {
            events.push({
                name: event.name.text,
                description: (event.summary || '').substring(0, 150) + '...',
                imageUrl: event.logo ? event.logo.original.url : null,
                sourceUrl: event.url,
                location: event.venue?.address?.localized_address_display || 'Online o por confirmar',
                date: new Date(event.start.local).toISOString().slice(0, 10),
            });
        } catch(e) { /* Silently fail */ }
    });
    return events;
};

// --- LISTA DE FUENTES PROPORCIONADA POR EL USUARIO ---
const sources = [
    // API
    { name: "Eventbrite", type: "api", city: "Nacional", scrape: scrapeEventbriteApi },
    // Nivel 1
    { name: "PanoramasGratis.cl", type: "html", url: "https://panoramasgratis.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "ChileCultura.gob.cl", type: "html", url: "https://chilecultura.gob.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "SantiagoCultura.cl", type: "html", url: "https://www.santiagocultura.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "ValpoCultura.cl", type: "html", url: "https://valpocultura.cl/", city: "Valparaíso", scrape: scrapeHtmlArticle },
    { name: "ConcepciónCultural.cl", type: "html", url: "https://www.concepcioncultural.cl/", city: "Concepción", scrape: scrapeHtmlArticle },
    { name: "TodoEnConce.cl", type: "html", url: "https://www.todoenconce.cl/", city: "Concepción", scrape: scrapeHtmlArticle },
    { name: "Día de los Patrimonios", type: "html", url: "https://www.diadelospatrimonios.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    // Nivel 2
    { name: "Centro Gabriela Mistral (GAM)", type: "html", url: "https://gam.cl/cartelera/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Centro Cultural La Moneda", type: "html", url: "https://www.cclm.cl/actividades/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Teatro Municipal de Santiago", type: "html", url: "https://municipal.cl/cartelera", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Corp. Cultural Las Condes", type: "html", url: "https://www.culturallascondes.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Corp. Cultural Lo Barnechea", type: "html", url: "https://www.corporacionculturaldelobarnechea.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Cultura Providencia", type: "html", url: "https://culturaprovidencia.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Biblioteca Nacional", type: "html", url: "https://www.bibliotecanacional.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Biblioteca de Santiago", type: "html", url: "https://www.bibliotecasantiago.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Universidad de Chile (Agenda)", type: "html", url: "https://uchile.cl/agenda", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "CEAC U. de Chile", type: "html", url: "https://www.ceacuchile.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "USACH (Agenda)", type: "html", url: "https://www.usach.cl/agenda-usach", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Planetario USACH", type: "html", url: "https://planetariochile.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Nacional de Historia Natural", type: "html", url: "https://www.mnhn.gob.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo de la Memoria y DD.HH.", type: "html", url: "https://museodelamemoria.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Chileno de Arte Precolombino", type: "html", url: "https://museo.precolombino.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Museo Artequin", type: "html", url: "https://artequin.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    // Nivel 3
    { name: "Cineteca Nacional de Chile", type: "html", url: "https://www.cclm.cl/cineteca-nacional-de-chile/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "CineChile.cl", type: "html", url: "https://cinechile.cl/cartelera/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "Retina Latina", type: "html", url: "https://www.retinalatina.org/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "Testing en Chile", type: "html", url: "https://www.testingenchile.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Congreso Futuro", type: "html", url: "https://congresofuturo.cl/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "Bicineta.cl", type: "html", url: "https://www.bicineta.cl/eventos", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "TusDesafios.com", type: "html", url: "https://tusdesafios.com/ciclismo/chile", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "TicketSport.cl", type: "html", url: "https://ticketsport.cl/eventos", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "IBBY Chile", type: "html", url: "https://www.ibbychile.cl/", city: "Santiago", scrape: scrapeHtmlArticle },
    { name: "Calavera Lectora", type: "html", url: "https://calaveralectora.org/", city: "Nacional", scrape: scrapeHtmlArticle },
    { name: "Bandsintown", type: "html", url: "https://www.bandsintown.com/es/c/chile", city: "Nacional", scrape: scrapeHtmlArticle },
    // Nivel 4 (RSS)
    { name: "Santiago Secreto (RSS)", type: "rss", url: "https://santiagosecreto.com/feed/", city: "Santiago", scrape: scrapeRssFeed },
    { name: "La Tercera Finde (RSS)", type: "rss", url: "https://www.latercera.com/finde/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Chilevisión Panoramas (RSS)", type: "rss", url: "https://www.chilevision.cl/tag/panoramas-gratis/feed", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Chile es Tuyo (RSS)", type: "rss", url: "https://chileestuyo.cl/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "El Mostrador Cultura (RSS)", type: "rss", url: "https://www.elmostrador.cl/cultura/feed/", city: "Nacional", scrape: scrapeRssFeed },
    { name: "Diario Concepción Cultura (RSS)", type: "rss", url: "https://www.diarioconcepcion.cl/cultura/feed/", city: "Concepción", scrape: scrapeRssFeed },
    // Nivel 5 (HTML)
    { name: "Municipalidad de Arica", type: "html", url: "https://www.muniarica.cl/", city: "Arica", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Iquique", type: "html", url: "https://www.municipioiquique.cl/", city: "Iquique", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Antofagasta", type: "html", url: "https://www.municipalidadantofagasta.cl/", city: "Antofagasta", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de La Serena", type: "html", url: "https://www.laserena.cl/", city: "La Serena", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Viña del Mar", type: "html", url: "https://www.munivina.cl/", city: "Viña del Mar", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Rancagua", type: "html", url: "https://www.rancagua.cl/", city: "Rancagua", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Talca", type: "html", url: "https://www.talca.cl/", city: "Talca", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Temuco", type: "html", url: "https://www.temuco.cl/", city: "Temuco", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Valdivia", type: "html", url: "https://www.munivaldivia.cl/", city: "Valdivia", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Puerto Montt", type: "html", url: "https://www.puertomontt.cl/", city: "Puerto Montt", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Coquimbo", type: "html", url: "https://www.municoquimbo.cl/", city: "Coquimbo", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Calama", type: "html", url: "https://www.municipalidadcalama.cl/", city: "Calama", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Copiapó", type: "html", url: "https://www.copiapo.cl/", city: "Copiapó", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Chillán", type: "html", url: "https://www.municipalidadchillan.cl/", city: "Chillán", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Osorno", type: "html", url: "https://www.municipalidadosorno.cl/", city: "Osorno", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Punta Arenas", type: "html", url: "https://www.puntaarenas.cl/", city: "Punta Arenas", scrape: scrapeHtmlArticle },
    { name: "Municipalidad de Coyhaique", type: "html", url: "https://www.coyhaique.cl/", city: "Coyhaique", scrape: scrapeHtmlArticle },
];


// --- MOTOR DE ANÁLISIS Y EXTRACCIÓN ---
function analyzeEventContent(title, description) {
    const fullText = (title + ' ' + (description || '')).toLowerCase();
    let planType = 'cualquiera';
    let budget = 0;

    const eventKeywords = ['entradas', 'tickets', 'cuándo', 'dónde', 'lugar', 'horario', 'inscríbete', 'reserva', 'invita', 'participa', 'festival', 'concierto', 'exposición', 'obra', 'función', 'cartelera'];
    const negativeKeywords = ['estos son', 'los mejores', 'la guía', 'hablamos con', 'entrevista', 'reseña', 'opinión', 'análisis', 'recuerda', 'revisa'];
    
    if (!eventKeywords.some(k => fullText.includes(k)) || negativeKeywords.some(k => title.toLowerCase().includes(k))) {
        return null; // No parece un evento accionable, se descarta.
    }

    const freeKeywords = ['gratis', 'gratuito', 'entrada liberada', 'sin costo', 'acceso gratuito'];
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
            let items = [];
            if (source.type === 'api') {
                const { data } = await axios.get(`https://www.eventbriteapi.com/v3/events/search/?location.address=${source.city}%2C+Chile&price=free&token=${EVENTBRITE_API_TOKEN}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
                items = source.scrape(data);
            } else {
                const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                if (source.type === 'rss') {
                    const parsedData = await parseStringPromise(data);
                    items = (parsedData.rss.channel[0].item || []).map(item => ({
                        title: item.title?.[0] || '', link: item.link?.[0] || '',
                        description: item.description?.[0].replace(/<[^>]*>?/gm, '') || '',
                        pubDate: item.pubDate?.[0] || new Date().toISOString()
                    }));
                } else { // html
                    items = source.scrape(cheerio.load(data), source.url);
                }
            }

            for (const item of items) {
                const eventData = item.name ? item : { name: item.title, sourceUrl: item.link, description: item.description, date: item.pubDate };
                const analysis = analyzeEventContent(eventData.name, eventData.description);
                if (analysis) {
                    allEvents.push({ ...eventData, city: source.city, ...analysis });
                }
            }
        } catch (error) { /* Silently ignore sources that fail */ }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents;
}

// --- API ENDPOINTS ---
app.get("/", (req, res) => res.send("Motor de Eventis v8 funcionando."));

app.get("/events", async (req, res) => {
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
        return res.status(500).json({ error: "El servidor no está configurado." });
    }
    try {
        const response = await axios.get(`${JSONBIN_URL}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
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
        // No guardamos la imagen en la bodega para mantenerla ligera
        const eventsToStore = events.map(({ imageUrl, ...rest }) => rest);
        await axios.put(JSONBIN_URL, { events: eventsToStore }, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY }
        });
        res.status(200).send(`Scraping completado. ${events.length} eventos de calidad guardados.`);
    } catch (error) {
        res.status(500).send("Error al guardar los eventos en la bodega.");
    }
});

const listener = app.listen(process.env.PORT, () => {
    console.log("Tu app está escuchando en el puerto " + listener.address().port);
});
