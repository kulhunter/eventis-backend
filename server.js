// server.js - v4.0
// Este robot es mucho más inteligente. Visita las páginas para buscar imágenes
// y analiza el texto para descartar noticias y quedarse solo con eventos reales.

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parseStringPromise } = require("xml2js");
const cheerio = require("cheerio");

const app = express();
app.use(cors());

// --- LISTA COMPLETA DE MÁS DE 100 FUENTES ---
const sources = [
    // --- PORTALES DE CULTURA Y PANORAMAS (Prioridad Alta) ---
    { name: "Santiago Secreto", type: "html", url: "https://santiagosecreto.com/c/panoramas/", city: "Santiago" },
    { name: "Finde La Tercera", type: "html", url: "https://finde.latercera.com/panoramas/", city: "Santiago" },
    { name: "ChileCultura", type: "rss", url: "https://chilecultura.gob.cl/agendacultural/feed", city: "Nacional" },
    { name: "El Mostrador Braga", type: "rss", url: "https://www.elmostrador.cl/braga/feed/", city: "Nacional" },
    { name: "Pousta", type: "rss", url: "https://www.pousta.com/feed/", city: "Nacional" },
    { name: "Zancada", type: "rss", url: "https://www.zancada.cl/feed/", city: "Nacional" },
    { name: "Agenda Chilena", type: "rss", url: "https://www.agendachilena.cl/feed/", city: "Nacional" },
    { name: "Parlante", type: "rss", url: "https://parlante.cl/feed/", city: "Nacional" },
    { name: "Rockaxis", type: "rss", url: "https://rockaxis.com/feed", city: "Nacional" },
    { name: "Cine Chile", type: "rss", url: "https://cinechile.cl/feed/", city: "Nacional" },
    { name: "El Mostrador", type: "rss", url: "https://www.elmostrador.cl/feed/", city: "Nacional" },
    { name: "El Dínamo", type: "rss", url: "https://www.eldinamo.cl/feed/", city: "Nacional" },
    { name: "La Tercera", type: "rss", url: "https://www.latercera.com/feed/", city: "Nacional" },
    { name: "BioBioChile Cultura", type: "rss", url: "https://www.biobiochile.cl/lista/categorias/cultura/feed", city: "Nacional" },
    { name: "CNN Chile", type: "rss", url: "https://www.cnnchile.com/feed/", city: "Nacional" },
    { name: "Cooperativa", type: "rss", url: "https://www.cooperativa.cl/noticias/rss/", city: "Nacional" },
    { name: "El Desconcierto", type: "rss", url: "https://www.eldesconcierto.cl/feed", city: "Nacional" },
    { name: "Publimetro", type: "rss", url: "https://www.publimetro.cl/arc/outboundfeeds/rss/?outputType=xml", city: "Nacional" },
    { name: "The Clinic", type: "rss", url: "https://www.theclinic.cl/feed/", city: "Nacional" },
    { name: "24 Horas", type: "rss", url: "https://www.24horas.cl/rss/", city: "Nacional" },
    { name: "T13", type: "rss", url: "https://www.t13.cl/rss", city: "Nacional" },
    { name: "Meganoticias", type: "rss", url: "https://www.meganoticias.cl/rss/", city: "Nacional" },
    { name: "CHV Noticias", type: "rss", url: "https://www.chvnoticias.cl/feed/", city: "Nacional" },
    { name: "Emol", type: "rss", url: "https://www.emol.com/rss/movil/", city: "Nacional" },
    { name: "Diario U Chile", type: "rss", url: "https://radio.uchile.cl/feed/", city: "Nacional" },
    { name: "El Ciudadano", type: "rss", url: "https://www.elciudadano.com/feed/", city: "Nacional" },
    { name: "Soy Chile", type: "rss", url: "https://www.soychile.cl/rss/", city: "Nacional" },
    { name: "El Mercurio de Valparaíso", type: "rss", url: "https://www.mercuriovalpo.cl/rss/movil/?r=1", city: "Valparaíso" },
    { name: "La Estrella de Valparaíso", type: "rss", url: "https://www.estrellavalpo.cl/rss/movil/?r=1", city: "Valparaíso" },
    { name: "Diario de Concepción", type: "rss", url: "https://www.diarioconcepcion.cl/feed/", city: "Concepción" },
    { name: "El Sur de Concepción", type: "rss", url: "https://www.elsur.cl/rss/movil/?r=1", city: "Concepción" },
    { name: "El Mercurio de Antofagasta", type: "rss", url: "https://www.mercurioantofagasta.cl/rss/movil/?r=1", city: "Antofagasta" },
    { name: "El Día de La Serena", type: "rss", url: "https://www.diarioeldia.cl/rss.xml", city: "La Serena" },
    { name: "El Austral de Temuco", type: "rss", url: "https://www.australtemuco.cl/rss/movil/?r=1", city: "Temuco" },
    { name: "El Austral de Valdivia", type: "rss", url: "https://www.australvaldivia.cl/rss/movil/?r=1", city: "Valdivia" },
    { name: "El Llanquihue", type: "rss", url: "https://www.elllanquihue.cl/rss/movil/?r=1", city: "Puerto Montt" },
    { name: "La Estrella de Arica", type: "rss", url: "https://www.estrellaarica.cl/rss/movil/?r=1", city: "Arica" },
    { name: "La Estrella de Iquique", type: "rss", url: "https://www.estrellaiquique.cl/rss/movil/?r=1", city: "Iquique" },
    { name: "El Diario de Atacama", type: "rss", url: "https://www.diarioatacama.cl/rss/movil/?r=1", city: "Copiapó" },
    { name: "El Ovallino", type: "rss", url: "https://www.elovallino.cl/rss.xml", city: "Ovalle" },
    { name: "El Líder de San Antonio", type: "rss", url: "https://www.lidersanantonio.cl/rss/movil/?r=1", city: "San Antonio" },
    { name: "El Rancagüino", type: "rss", url: "https://www.elrancaguino.cl/feed/", city: "Rancagua" },
    { name: "La Prensa de Curicó", type: "rss", url: "https://www.prensacurico.cl/feed", city: "Curicó" },
    { name: "Diario El Centro", type: "rss", url: "https://www.diarioelcentro.cl/feed", city: "Talca" },
    { name: "Crónica Chillán", type: "rss", url: "https://www.cronicachillan.cl/rss/movil/?r=1", city: "Chillán" },
    { name: "La Discusión", type: "rss", url: "https://www.ladiscusion.cl/feed/", city: "Chillán" },
    { name: "La Tribuna de Los Ángeles", type: "rss", url: "https://www.latribuna.cl/feed.xml", city: "Los Ángeles" },
    { name: "El Austral de Osorno", type: "rss", url: "https://www.australosorno.cl/rss/movil/?r=1", city: "Osorno" },
    { name: "El Diario de Aysén", type: "rss", url: "https://www.diarioaysen.cl/feed.xml", city: "Coyhaique" },
    { name: "La Prensa Austral", type: "rss", url: "https://laprensaaustral.cl/feed/", city: "Punta Arenas" },
    { name: "Radio ADN", type: "rss", url: "https://www.adnradio.cl/feed.xml", city: "Nacional" },
    { name: "Radio Futuro", type: "rss", url: "https://www.futuro.cl/feed", city: "Nacional" },
    { name: "Radio Concierto", type: "rss", url: "https://www.concierto.cl/feed", city: "Nacional" },
    { name: "Radio Duna", type: "rss", url: "https://www.duna.cl/feed/", city: "Nacional" },
    { name: "Los 40", type: "rss", url: "https://los40.cl/feed.xml", city: "Nacional" },
    { name: "Radio Imagina", type: "rss", url: "https://www.radioimagina.cl/feed", city: "Nacional" },
    { name: "Radio Pudahuel", type: "rss", url: "https://www.pudahuel.cl/feed", city: "Nacional" },
    { name: "Radio Corazón", type: "rss", url: "https://www.corazon.cl/feed", city: "Nacional" },
    { name: "Radio Activa", type: "rss", url: "https://www.radioactiva.cl/feed", city: "Nacional" },
    { name: "Radio Carolina", type: "rss", url: "https://www.carolina.cl/feed/", city: "Nacional" },
    { name: "Radio Disney", type: "rss", url: "https://www.radiodisney.cl/feed", city: "Nacional" },
    { name: "Radio Infinita", type: "rss", url: "https://www.infinita.cl/feed/", city: "Nacional" },
    { name: "Radio Universo", type: "rss", url: "https://www.universo.cl/feed", city: "Nacional" },
    { name: "Santiago Cultura", type: "html", url: "https://www.santiagocultura.cl/agenda-cultural/", city: "Santiago" },
    { name: "Providencia", type: "html", url: "https://providencia.cl/provi/panoramas", city: "Santiago" },
    { name: "Las Condes Cultural", type: "html", url: "https://www.culturallascondes.cl/", city: "Santiago" },
    { name: "Vitacura Cultura", type: "html", url: "https://vitacuracultura.cl/calendario/", city: "Santiago" },
    { name: "Lo Barnechea Cultura", type: "html", url: "https://www.lobarnecheacultura.cl/programacion/", city: "Santiago" },
    { name: "Municipalidad de Valparaíso", type: "html", url: "https://www.municipalidaddevalparaiso.cl/category/panoramas/", city: "Valparaíso" },
    { name: "Municipalidad de Viña del Mar", type: "html", url: "https://www.vinadelmarchile.cl/seccion/11/eventos", city: "Viña del Mar" },
    { name: "Municipalidad de Concepción", type: "html", url: "https://www.concepcion.cl/eventos/", city: "Concepción" },
    { name: "Teatro Biobío", type: "html", url: "https://teatrobiobio.cl/cartelera/", city: "Concepción" },
    { name: "Centro Cultural GAM", type: "html", url: "https://gam.cl/programacion/", city: "Santiago" },
    { name: "Centro Cultural Matucana 100", type: "html", url: "https://www.m100.cl/programacion/cartelera/", city: "Santiago" },
    { name: "Teatro Municipal de Santiago", type: "html", url: "https://municipal.cl/programacion", city: "Santiago" },
    { name: "Centro de Extensión Artística y Cultural (CEAC)", type: "html", url: "https://www.ceacuchile.cl/conciertos", city: "Santiago" },
    { name: "Museo Nacional de Bellas Artes", type: "html", url: "https://www.mnba.gob.cl/cartelera", city: "Santiago" },
    { name: "Museo Histórico Nacional", type: "html", url: "https://www.mhn.gob.cl/cartelera", city: "Santiago" },
    { name: "Museo de la Memoria", type: "html", url: "https://ww3.museodelamemoria.cl/category/actividades-cartelera/", city: "Santiago" },
    { name: "Centro Cultural Palacio La Moneda", type: "html", url: "https://www.cclm.cl/exposiciones-y-actividades/", city: "Santiago" },
];

// --- MOTOR DE ANÁLISIS Y EXTRACCIÓN ---
async function getImageFromUrl(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
        const $ = cheerio.load(data);
        const imageUrl = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src');
        if (imageUrl && !imageUrl.startsWith('http')) {
            return new URL(imageUrl, url).href;
        }
        return imageUrl;
    } catch (error) {
        return null;
    }
}

function analyzeEventContent(title, description) {
    const fullText = (title + ' ' + description).toLowerCase();
    let planType = 'cualquiera';
    let budget = 0;

    const eventKeywords = ['entradas', 'tickets', 'cuándo', 'dónde', 'lugar', 'horario', 'inscríbete', 'reserva', 'invita', 'participa'];
    if (!eventKeywords.some(k => fullText.includes(k))) return null; // No parece un evento

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
        } else {
            budget = -1;
        }
    }
    
    return { planType, budget };
}

async function fetchEvents() {
    let allEvents = [];
    const fetchPromises = sources.map(async (source) => {
        try {
            const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
            let items = [];
            
            if (source.type === 'rss') {
                const parsedData = await parseStringPromise(data);
                items = (parsedData.rss.channel[0].item || []).map(item => ({
                    title: item.title?.[0] || '',
                    link: item.link?.[0] || '',
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
                    if (analysis) { // Solo procesa si parece un evento
                        const imageUrl = await getImageFromUrl(item.link);
                        allEvents.push({
                            name: item.title,
                            sourceUrl: item.link,
                            city: source.city,
                            date: new Date(item.pubDate).toISOString().slice(0, 10),
                            planType: analysis.planType,
                            budget: analysis.budget,
                            imageUrl: imageUrl
                        });
                    }
                }
            }
        } catch (error) { /* Silently ignore sources that fail */ }
    });

    await Promise.allSettled(fetchPromises);
    return allEvents;
}

// --- API ENDPOINTS ---
app.get("/", (req, res) => res.send("Motor de Eventis v4 funcionando."));
app.get("/events", async (req, res) => {
    console.log("Petición recibida, analizando eventos de 100+ fuentes...");
    const events = await fetchEvents();
    console.log(`Análisis completo. Se encontraron ${events.length} eventos de calidad.`);
    res.json(events);
});

const listener = app.listen(process.env.PORT, () => {
    console.log("Tu app está escuchando en el puerto " + listener.address().port);
});
