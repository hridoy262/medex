const path = require('path');
require('dotenv').config();
if (!process.env.MONGODB_URI) {
    require('dotenv').config({ path: path.join(__dirname, 'atlas-credentials.env') });
}
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;

// ১. ডাটাবেজ কানেকশন
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('🍃 MongoDB Atlas Connected Successfully!'))
    .catch(err => console.error('Database connection error:', err));

// ২. ডাটাবেজের কাঠামো (Schema)
const medicineSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    generic: String,
    company: String,
    strength: String,
    price: String,
    dosageForm: String,
    sourceUrl: String,
    priceUpdatedAt: Date,
    priceSourceUrl: String,
    lastUpdated: { type: Date, default: Date.now }
});

const Medicine = mongoose.model('Medicine', medicineSchema);

const medicineCsvSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    generic: String,
    name: { type: String, required: true },
    company: String,
    strength: String,
    price: String,
    dosageForm: String,
    priceUpdatedAt: Date,
    priceSourceUrl: String
}, { versionKey: false });

medicineCsvSchema.index({ name: 1 }, { collation: { locale: 'en', strength: 2 } });
medicineCsvSchema.index({ generic: 1 }, { collation: { locale: 'en', strength: 2 } });

const CsvMedicine = mongoose.model('CsvMedicine', medicineCsvSchema, 'medicine_csv');

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchText(value) {
    return (value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeCompanyName(value) {
    return normalizeSearchText(value)
        .replace(/\b(?:limited|ltd|plc)\b/g, '')
        .trim()
        .replace(/\s+/g, ' ');
}

function scoreCsvMedicine(medicine, query, tokens) {
    const name = normalizeSearchText(medicine.name);
    const generic = normalizeSearchText(medicine.generic);
    const company = normalizeSearchText(medicine.company);

    if (name === query) return 1000;
    if (name.startsWith(query)) return 900;
    if (name.includes(query)) return 800;
    if (generic === query) return 700;
    if (generic.startsWith(query)) return 650;
    if (generic.includes(query)) return 600;
    if (company === query) return 500;
    if (company.startsWith(query)) return 450;
    if (company.includes(query)) return 400;

    const searchableText = `${name} ${generic} ${company}`;
    if (tokens.every(token => searchableText.includes(token))) return 300;
    return 0;
}

function getMedicineData(medicine) {
    return typeof medicine.toObject === 'function' ? medicine.toObject() : medicine;
}

function withOnlinePrice(medicine, onlineMedicine) {
    const savedMedicine = getMedicineData(medicine);
    const livePrice = onlineMedicine && String(onlineMedicine.price || '').trim();

    return {
        ...savedMedicine,
        price: livePrice || null,
        priceStatus: livePrice ? 'online' : 'unavailable',
        dosageForm: onlineMedicine?.dosageForm || savedMedicine.dosageForm,
        priceSourceUrl: livePrice ? (onlineMedicine.priceSourceUrl || onlineMedicine.sourceUrl) : null
    };
}

async function scrapeMedicineDetails(detailUrl) {
    try {
        const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
        const detailResponse = await axios.get(detailUrl, { headers, timeout: 12000 });
        const $$ = cheerio.load(detailResponse.data);

        const brandHeading = $$('h1.page-heading-1-l').first().clone();
        brandHeading.find('small').remove();
        const brandName = brandHeading.text().trim() || $$('h1.page-heading-1-l').text().trim();
        const companyName = $$('div[title="Manufactured by"] a').first().text().trim()
            || $$('div.ac-b').find('a').first().text().trim()
            || "N/A";
        const genericName = $$('div[title="Generic Name"] a').first().text().trim()
            || $$('div.ac-g').find('a').first().text().trim()
            || "N/A";
        const strength = $$('div[title="Strength"]').first().text().trim();
        
        const packageContainer = $$('.packages-wrapper .package-container').first();
        let price = packageContainer.find('span').eq(1).text().trim();
        if (!price) price = $$('span.package-price').text().trim();
        if (!price) price = $$('div.price-container').text().trim();
        if (!brandName || !/[0-9]/.test(price)) return null;

        return {
            name: brandName,
            generic: genericName,
            company: companyName,
            strength,
            price,
            sourceUrl: detailUrl,
            lastUpdated: new Date()
        };
    } catch (error) {
        console.error("Scraping error:", error.message);
        return null;
    }
}

// ৩. লাইভ ওয়েব স্ক্র্যাপার ফাংশন
async function scrapeMedicineFromWeb(medicineName, expectedMedicine) {
    try {
        const searchUrl = `https://medex.com.bd/search?search=${encodeURIComponent(medicineName)}`;
        const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
        const searchResponse = await axios.get(searchUrl, { headers, timeout: 12000 });
        const $ = cheerio.load(searchResponse.data);
        let brandResult;
        if (expectedMedicine) {
            const expectedLabel = normalizeSearchText(`${expectedMedicine.name} ${expectedMedicine.strength}`);
            const expectedCompany = normalizeCompanyName(expectedMedicine.company);
            const matches = $('a[href*="/brands/"]').toArray().filter(link => {
                const result = $(link);
                const label = normalizeSearchText(result.text());
                const description = normalizeCompanyName(result.closest('.search-result-row').text());
                return (label === expectedLabel || label.startsWith(`${expectedLabel} `))
                    && description.includes(expectedCompany);
            });
            const commonForms = matches.filter(link => {
                const form = $(link).closest('.search-result-title').find('img').attr('title')
                    || $(link).closest('.search-result-title').find('img').attr('alt')
                    || '';
                return /^(tablet|capsule)$/i.test(form);
            });
            const match = commonForms.length === 1 ? commonForms[0] : matches.length === 1 ? matches[0] : null;
            if (match) brandResult = $(match);
        } else {
            const firstResult = $('a.hoverable-block[href*="/brands/"]').first();
            brandResult = firstResult.length ? firstResult : $('a[href*="/brands/"]').first();
        }

        if (!brandResult || !brandResult.length) return null;

        const detailUrl = new URL(brandResult.attr('href'), searchUrl).href;
        const medicine = await scrapeMedicineDetails(detailUrl);
        if (!medicine) return null;

        if (expectedMedicine) {
            const expectedName = normalizeSearchText(expectedMedicine.name);
            const actualName = normalizeSearchText(medicine.name);
            if (!actualName.startsWith(expectedName)) return null;
        }

        return medicine;
    } catch (error) {
        console.error("Scraping error:", error.message);
        return null;
    }
}

async function refreshCsvMedicinePrices(searchName, medicines) {
    const searchUrl = `https://medex.com.bd/search?search=${encodeURIComponent(searchName)}`;
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

    try {
        const searchResponse = await axios.get(searchUrl, { headers, timeout: 12000 });
        const $ = cheerio.load(searchResponse.data);
        const resultLinks = $('a[href*="/brands/"]').toArray().map(link => {
            const result = $(link);
            return {
                url: new URL(result.attr('href'), searchUrl).href,
                label: normalizeSearchText(result.text()),
                description: normalizeSearchText(result.closest('.search-result-row').text()),
                dosageForm: result.closest('.search-result-title').find('img').attr('title')
                    || result.closest('.search-result-title').find('img').attr('alt')
                    || ''
            };
        });
        const matchingLinks = new Map();

        medicines.forEach(medicine => {
            const expectedLabel = normalizeSearchText(`${medicine.name} ${medicine.strength}`);
            const expectedCompany = normalizeCompanyName(medicine.company);
            if (!expectedLabel || !expectedCompany) return;

            const matches = resultLinks.filter(result =>
                (result.label === expectedLabel || result.label.startsWith(`${expectedLabel} `))
                && normalizeCompanyName(result.description).includes(expectedCompany)
            );
            const commonForms = matches.filter(result => /^(tablet|capsule)$/i.test(result.dosageForm));
            const match = commonForms.length === 1
                ? commonForms[0]
                : matches.length === 1 ? matches[0] : null;
            if (match) {
                const matches = matchingLinks.get(match.url) || [];
                matches.push({ medicine, dosageForm: match.dosageForm });
                matchingLinks.set(match.url, matches);
            }
        });

        const refreshed = [];
        const entries = Array.from(matchingLinks.entries());
        for (let index = 0; index < entries.length; index += 5) {
            const batch = entries.slice(index, index + 5);
            const results = await Promise.all(batch.map(async ([url, matchedMedicines]) => ({
                matchedMedicines,
                onlineMedicine: await scrapeMedicineDetails(url)
            })));

            results.forEach(({ matchedMedicines, onlineMedicine }) => {
                if (!onlineMedicine) return;
                const priceUpdatedAt = new Date();
                matchedMedicines.forEach(({ medicine, dosageForm }) => {
                    refreshed.push({
                        ...(typeof medicine.toObject === 'function' ? medicine.toObject() : medicine),
                        price: onlineMedicine.price,
                        dosageForm,
                        priceUpdatedAt,
                        priceSourceUrl: onlineMedicine.sourceUrl
                    });
                });
            });
        }

        return refreshed;
    } catch (error) {
        console.error("Online price refresh error:", error.message);
        return [];
    }
}

// ৪. এপিআই এন্ডপয়েন্ট
app.get('/api/medicine', async (req, res) => {
    const searchName = req.query.name;
    if (typeof searchName !== 'string' || !searchName.trim()) {
        return res.status(400).json({ error: "অনুগ্রহ করে 'name' কুয়েরি প্যারামিটার দিন।" });
    }

    try {
        const normalizedSearchName = normalizeSearchText(searchName);
        const searchTokens = normalizedSearchName.split(' ').filter(Boolean);
        const escapedSearchName = escapeRegex(searchName.trim());
        const exactCsvMedicines = await CsvMedicine.find({ name: searchName.trim() })
            .collation({ locale: 'en', strength: 2 })
            .sort({ company: 1, strength: 1 });

        if (exactCsvMedicines.length) {
            const refreshedMedicines = await refreshCsvMedicinePrices(searchName.trim(), exactCsvMedicines);
            const refreshedById = new Map(refreshedMedicines.map(medicine => [String(medicine._id), medicine]));
            return res.json({
                source: "medex",
                data: exactCsvMedicines.map(medicine =>
                    withOnlinePrice(medicine, refreshedById.get(String(medicine._id)))
                )
            });
        }

        const exactGenericMedicines = await CsvMedicine.find({ generic: searchName.trim() })
            .collation({ locale: 'en', strength: 2 })
            .sort({ name: 1, company: 1, strength: 1 })
            .limit(20);

        if (exactGenericMedicines.length) {
            const refreshedMedicines = await refreshCsvMedicinePrices(searchName.trim(), exactGenericMedicines);
            const refreshedById = new Map(refreshedMedicines.map(medicine => [String(medicine._id), medicine]));
            return res.json({
                source: "medex",
                data: exactGenericMedicines.map(medicine =>
                    withOnlinePrice(medicine, refreshedById.get(String(medicine._id)))
                )
            });
        }

        if (normalizedSearchName.length >= 2) {
            const tokenConditions = searchTokens.map(token => {
                const tokenPattern = new RegExp(escapeRegex(token), 'i');
                return {
                    $or: [
                        { name: tokenPattern },
                        { generic: tokenPattern },
                        { company: tokenPattern }
                    ]
                };
            });
            const candidates = await CsvMedicine.find({ $and: tokenConditions })
                .limit(200)
                .lean();
            const rankedMedicines = candidates
                .map(medicine => ({
                    medicine,
                    score: scoreCsvMedicine(medicine, normalizedSearchName, searchTokens)
                }))
                .filter(result => result.score > 0)
                .sort((left, right) =>
                    right.score - left.score
                    || left.medicine.name.localeCompare(right.medicine.name)
                    || (left.medicine.strength || '').localeCompare(right.medicine.strength || '')
                )
                .slice(0, 20)
                .map(result => result.medicine);

            if (rankedMedicines.length) {
                const refreshedMedicines = await refreshCsvMedicinePrices(searchName.trim(), rankedMedicines);
                const refreshedById = new Map(refreshedMedicines.map(medicine => [String(medicine._id), medicine]));
                return res.json({
                    source: "medex",
                    data: rankedMedicines.map(medicine =>
                        withOnlinePrice(medicine, refreshedById.get(String(medicine._id)))
                    )
                });
            }
        }

        // ডাটাবেজে আগে থেকে আছে কিনা দেখা
        let medicine = await Medicine.findOne({
            name: { $regex: `^${escapedSearchName}$`, $options: 'i' }
        });

        if (medicine) {
            const freshData = await scrapeMedicineFromWeb(searchName, medicine);
            if (freshData) {
                return res.json({
                    source: "medex",
                    data: { ...freshData, priceStatus: 'online', priceSourceUrl: freshData.sourceUrl }
                });
            }
            return res.json({
                source: "medex",
                data: withOnlinePrice(medicine, null)
            });
        }

        // ডাটাবেজে না থাকলে লাইভ স্ক্র্যাপ করা
        console.log(`🔍 ডাটাবেজে পাওয়া যায়নি। '${searchName}' লাইভ সার্চ করা হচ্ছে...`);
        const scrapedData = await scrapeMedicineFromWeb(searchName);

        if (!scrapedData) {
            return res.status(404).json({ error: "এই নামের কোনো ওষুধ খুঁজে পাওয়া যায়নি।" });
        }

        await Medicine.findOneAndUpdate(
            { name: scrapedData.name },
            { $set: {
                name: scrapedData.name,
                generic: scrapedData.generic,
                company: scrapedData.company,
                strength: scrapedData.strength,
                sourceUrl: scrapedData.sourceUrl,
                lastUpdated: scrapedData.lastUpdated
            } },
            { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
        );

        return res.json({
            source: "medex",
            data: { ...scrapedData, priceStatus: 'online', priceSourceUrl: scrapedData.sourceUrl }
        });

    } catch (err) {
        return res.status(500).json({ error: "সার্ভারে সমস্যা হয়েছে।", details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 API Server running on: http://localhost:${PORT}`);
});