// server.js - v9.0 (Integración con Google Gemini AI)
// Este robot utiliza IA para analizar y reescribir la información de eventos.

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parseStringPromise } = require("xml2js");
const cheerio = require("cheerio");
const { GoogleGenerativeAI } = require("@google/generative-ai"); // <-- NUEVO: Importa la librería de Gemini

const app = express();
app.use(cors());

// --- CONFIGURACIÓN DE SECRETOS (se deben añadir en Render) ---
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const SCRAPE_SECRET_KEY = process.env.SCRAPE_SECRET_KEY;
const EVENTBRITE_API_TOKEN = process.env.EVENTBRITE_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // <-- NUEVO: Clave de la API de Gemini

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// --- Configuración de Google Gemini AI ---
let geminiModel;
if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log("IA Gemini inicializada.");
} else {
    console.warn("ADVERTENCIA: GEMINI_API_KEY no está configurada. La IA no se utilizará para el análisis.");
}

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
                events.push({ name: title, description: description.substring(0, 500) + '...', imageUrl, sourceUrl: link, rawDate: item.pubDate?.[0] }); // Almacenar rawDate para IA
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeHtmlArticle = ($, baseURI) => {
    const events = [];
    // Selectores más específicos pueden ser necesarios para cada fuente si dan malos resultados
    $("article, .evento, .event-item, .activity-card, .post-card, .card").each((index, element) => {
        try {
            const titleElement = $(element).find("h1, h2, h3, .title, .nombre-evento, .card-title").first();
            const title = titleElement.text().trim();
            let url = titleElement.find("a").attr("href") || $(element).find("a").first().attr("href");
            const description = $(element).find("p, .description, .bajada, .card-text").first().text().trim();
            let imageUrl = $(element).find("img").attr('src');

            if (url && !url.startsWith('http')) url = new URL(url, baseURI).href;
            if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseURI).href;

            // Filtro básico pre-IA para descartar contenido obvio no-evento
            if (title.toLowerCase().includes("buscador bn") || title.toLowerCase().includes("ver más") || description.length < 15) {
                return; // Saltar si es un título/descripción genérico o muy corto
            }

            if (title && url) { // La descripción se puede complementar con IA
                events.push({ name: title, description: description.substring(0, 500) + '...', imageUrl, sourceUrl: url });
            }
        } catch (e) { /* Silently fail */ }
    });
    return events;
};

const scrapeEventbriteApi = (apiResponse) => {
    const events = [];
    const eventList = apiResponse.events || apiResponse.data?.events;
    
    if (!eventList || !Array.isArray(eventList)) {
        console.warn("[Eventbrite] La respuesta de la API no contiene un array 'events' o no es un array.", apiResponse);
        return events;
    }

    eventList.forEach(event => {
        try {
            const name = event.name?.text || '';
            const description = event.summary || event.description?.text || '';
            const imageUrl = event.logo ? event.logo.original.url : null;
            const sourceUrl = event.url || '';
            const location = event.venue?.address?.localized_address_display || 'Online o por confirmar';
            const rawDate = event.start?.local ? new Date(event.start.local).toISOString() : null; // Mantener fecha raw para IA

            if (name && sourceUrl) {
                events.push({ name, description, imageUrl, sourceUrl, location, rawDate });
            }
        } catch(e) { 
            console.error("Error al procesar un evento de Eventbrite:", e.message, event);
        }
    });
    return events;
};

// --- FUNCIÓN DE ANÁLISIS Y REESCRITURA CON IA (GEMINI) ---
async function processWithAI(eventData) {
    if (!geminiModel) {
        console.warn("[IA Gemini] Modelo no inicializado. Saltando análisis con IA.");
        return null; // O podrías devolver el evento tal cual o aplicar analyzeEventContent clásico
    }

    // Construye un prompt claro para la IA. Pide un JSON estructurado.
    const prompt = `Analiza el siguiente contenido que podría ser un evento.
Si es un evento público y accionable (no una noticia, un artículo, un anuncio genérico o una llamada a la acción como "ver más"), extrae la siguiente información.
Si NO es un evento, o no se puede extraer la información clave, responde SOLAMENTE con un JSON: {"isEvent": false}.
Si es un evento, responde SOLAMENTE con un JSON en este formato:
{
  "isEvent": true,
  "name": "Nombre conciso y atractivo del evento",
  "description": "Descripción breve y clara del evento, máximo 150 caracteres. Evita frases como 'click aquí' o 'más información'.",
  "location": "Ubicación del evento (ej. 'Santiago', 'Parque X', 'Online')",
  "date": "Fecha del evento en formato AAAA-MM-DD (ej. '2025-08-15'). Si hay rango de fechas, pon la de inicio. Si no hay fecha clara o es evento continuo, pon 'Sin fecha'.",
  "budget": 0 | 10 | 20 | 30 | 40 | 50 | 51, // 0 para gratis, -1 para precio desconocido, 10 para <=10 USD, 20 para <=20 USD, etc., 51 para >50 USD.
  "planType": "solo" | "pareja" | "grupo" | "familiar" | "cualquiera", // Cómo se disfruta mejor el evento
  "sourceUrl": "URL original del evento"
}

Contenido a analizar:
Nombre Original: ${eventData.name || 'No especificado'}
Descripción Original: ${eventData.description || 'No especificado'}
URL Original: ${eventData.sourceUrl || 'No especificado'}
Ubicación Original (si aplica): ${eventData.location || 'No especificado'}
Fecha Original (si aplica): ${eventData.rawDate || 'No especificado'}
`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const responseText = result.response.text();
        console.log(`[IA Gemini] Respuesta cruda para "${eventData.name.substring(0, 30)}...": ${responseText.substring(0, 200)}...`);

        // Intenta extraer el JSON de la respuesta, que a veces puede venir con texto extra
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const jsonString = jsonMatch[0];
            const parsedResult = JSON.parse(jsonString);

            if (parsedResult.isEvent) {
                // Asegúrate de que los campos obligatorios existan o sean cadenas vacías/null
                parsedResult.name = parsedResult.name || eventData.name || 'Sin Título';
                parsedResult.description = parsedResult.description || eventData.description?.substring(0,150) || 'Sin descripción.';
                parsedResult.location = parsedResult.location || eventData.location || 'Por confirmar';
                parsedResult.date = parsedResult.date || 'Sin fecha';
                parsedResult.budget = parsedResult.budget !== undefined ? parsedResult.budget : -1; // -1 si no se pudo determinar
                parsedResult.planType = parsedResult.planType || 'cualquiera';
                parsedResult.sourceUrl = parsedResult.sourceUrl || eventData.sourceUrl;
                
                return parsedResult;
            }
        }
        return { isEvent: false }; // Si no se encuentra un JSON válido o isEvent es false
    } catch (aiError) {
        console.error(`[IA Gemini] Error al llamar o parsear IA para "${eventData.name}":`, aiError.message);
        // Si hay un error con la IA, puedes optar por descartar o usar el análisis clásico
        return { isEvent: false }; 
    }
}


async function fetchAllEvents() {
    let allEvents = [];
    const fetchPromises = sources.map(async (source) => {
        try {
            let items = [];
            if (source.type === 'api') {
                // --- Depuración Eventbrite ---
                if (!EVENTBRITE_API_TOKEN) {
                    console.error("[Eventbrite] EVENTBRITE_API_TOKEN no está configurado.");
                    return;
                }
                const apiUrl = `https://www.eventbriteapi.com/v3/events/search/?location.address=${encodeURIComponent(source.city)}%2C+Chile&price=free&token=${EVENTBRITE_API_TOKEN}`;
                console.log(`[Eventbrite] Intentando buscar en URL: ${apiUrl}`);
                try {
                    const { data } = await axios.get(apiUrl, { 
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                            'Accept': 'application/json' 
                        }, 
                        timeout: 15000 
                    });
                    console.log(`[Eventbrite] Respuesta cruda (primeros 500 chars): ${JSON.stringify(data).substring(0, 500)}...`);
                    items = source.scrape(data);
                    console.log(`[Eventbrite] Items brutos extraídos (antes de IA): ${items.length}`);
                } catch (apiError) {
                    console.error(`[Eventbrite] Error en la llamada API para ${source.city}:`, apiError.message);
                    if (apiError.response) {
                        console.error(`[Eventbrite] Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`);
                    }
                }
            } else { // HTML o RSS
                console.log(`[Scraping] Intentando buscar en: ${source.url}`);
                const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                if (source.type === 'rss') {
                    items = scrapeRssFeed({ rss: { channel: [{ item: await parseStringPromise(data).then(p => p.rss.channel[0].item) }] } });
                } else { // html
                    items = scrapeHtmlArticle(cheerio.load(data), source.url);
                }
                console.log(`[Scraping] Items brutos extraídos de ${source.name} (antes de IA): ${items.length}`);
            }

            // --- PROCESAMIENTO CON IA ---
            for (const item of items) {
                // Combinamos la data bruta para enviar a la IA
                const eventDataForAI = {
                    name: item.name,
                    description: item.description,
                    sourceUrl: item.sourceUrl,
                    imageUrl: item.imageUrl, // Necesitamos la imagen original después
                    location: item.location || source.city, // Usar ciudad de la fuente como fallback de ubicación
                    rawDate: item.rawDate // Fecha bruta para que la IA la interprete
                };

                const aiProcessedResult = await processWithAI(eventDataForAI);

                if (aiProcessedResult && aiProcessedResult.isEvent) {
                    // Si la IA confirma que es un evento y lo procesa, usamos sus datos.
                    allEvents.push({
                        name: aiProcessedResult.name,
                        description: aiProcessedResult.description,
                        imageUrl: item.imageUrl, // Mantenemos la URL de imagen original
                        sourceUrl: aiProcessedResult.sourceUrl,
                        city: aiProcessedResult.location, // La IA debería dar una ubicación más específica
                        planType: aiProcessedResult.planType,
                        budget: aiProcessedResult.budget,
                        location: aiProcessedResult.location, // Aquí se repite para claridad, puedes simplificarlo si quieres
                        date: aiProcessedResult.date
                    });
                } else {
                    console.log(`[IA Gemini] Evento descartado por IA o no procesado: "${item.name.substring(0, 50)}..."`);
                }
            }
        } catch (error) { 
            console.error(`Error general al procesar la fuente ${source.name} (${source.url || 'API'}):`, error.message);
            if (error.response) {
                console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
        }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents;
}

// --- API ENDPOINTS ---
app.get("/", (req, res) => res.send("Motor de Eventis v9.0 funcionando (con IA Gemini)."));

app.get("/events", async (req, res) => {
    if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
        return res.status(500).json({ error: "El servidor no está configurado correctamente (JSONBin API Key/ID faltantes)." });
    }
    try {
        const response = await axios.get(`${JSONBIN_URL}/latest`, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
        res.json(response.data.record.events);
    } catch (error) {
        console.error("Error al obtener eventos de JSONBin:", error.message);
        res.status(500).json({ error: "No se pudo obtener la lista de eventos de la bodega." });
    }
});

app.get("/run-scrape", async (req, res) => {
    const { key } = req.query;
    if (key !== SCRAPE_SECRET_KEY) {
        return res.status(401).send("Clave secreta inválida. Acceso no autorizado.");
    }
    
    console.log("Scraping activado...");
    const events = await fetchAllEvents();
    console.log(`Análisis completo. Se encontraron ${events.length} eventos de calidad (post-IA).`);

    try {
        const eventsToStore = events.map(({ imageUrl, ...rest }) => rest);
        await axios.put(JSONBIN_URL, { events: eventsToStore }, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY }
        });
        res.status(200).send(`Scraping completado. ${events.length} eventos de calidad guardados en JSONBin.`);
    } catch (error) {
        console.error("Error al guardar los eventos en la bodega JSONBin:", error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send("Error al guardar los eventos en la bodega. Revisa los logs.");
    }
});

const listener = app.listen(process.env.PORT || 3000, () => {
    console.log("Tu app Eventis v9.0 está escuchando en el puerto " + listener.address().port);
});
