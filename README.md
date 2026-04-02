# Kartony Bor – Deployment Guide

Webová aplikace pro řízení zásob kartonů (Warehouse 8496).  
Stack: **Next.js** + **Supabase** + **Vercel**

---

## 1. Supabase – databáze

### Vytvoření projektu
1. Jdi na [supabase.com](https://supabase.com) → **New Project**
2. Vyber region (eu-central-1 pro DE/CZ)
3. Zapamatuj si heslo k databázi

### Spuštění SQL schématu
1. V Supabase dashboardu → **SQL Editor**
2. Zkopíruj obsah souboru `supabase/schema.sql`
3. Klikni **Run** – vytvoří tabulky + naplní výchozí data

### Získání API klíčů
1. **Settings** → **API**
2. Zapiš si:
   - `Project URL` → to je `NEXT_PUBLIC_SUPABASE_URL`
   - `anon / public key` → to je `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

## 2. GitHub – repozitář

```bash
# Inicializace repozitáře
cd kartony-bor
git init
git add .
git commit -m "Initial commit"

# Vytvoř repo na github.com, pak:
git remote add origin https://github.com/TVUJ_USERNAME/kartony-bor.git
git push -u origin main
```

---

## 3. Vercel – deployment

### Propojení
1. Jdi na [vercel.com](https://vercel.com) → **Add New Project**
2. Importuj svůj GitHub repozitář
3. Framework: **Next.js** (autodetekce)

### Environment variables
V nastavení projektu na Vercelu → **Settings** → **Environment Variables**:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `tvuj-anon-key` |

### Deploy
Klikni **Deploy**. Vercel automaticky:
- Nainstaluje závislosti
- Buildne Next.js
- Nasadí na `kartony-bor.vercel.app` (nebo vlastní doménu)

---

## 4. Použití

### Přístup
Po deploy bude aplikace dostupná na URL od Vercelu.  
Kdokoli s odkazem se dostane k aplikaci – žádný login není potřeba.

### SAP upload
1. Exportuj LIPS report ze SAPu jako `.xlsx`
2. V aplikaci → tab **SAP Data** → **Vybrat LIPS.xlsx**
3. Data se automaticky zpracují a uloží do Supabase

### Aktualizace stavů
- **Hromadná editace**: přepíše všechny stavy naráz (po fyzickém sčítání)
- **Rychlé úpravy**: ±1 / ±5 tlačítka pro průběžné korekce

### Multi-device
Všechna data jsou v Supabase – změny z jednoho zařízení jsou okamžitě vidět na ostatních po refreshi.

---

## 5. Lokální vývoj

```bash
# Instalace
npm install

# Vytvoř .env.local
cp .env.local.example .env.local
# Vyplň Supabase credentials

# Spusť dev server
npm run dev
# → http://localhost:3000
```

---

## Struktura projektu

```
kartony-bor/
├── app/
│   ├── globals.css          # Tailwind + custom CSS
│   ├── layout.tsx           # Root layout
│   └── page.tsx             # Entry point
├── components/
│   └── Dashboard.tsx        # Hlavní dashboard komponenta
├── lib/
│   └── supabase.ts          # Supabase client + API funkce
├── supabase/
│   └── schema.sql           # DB schéma + seed data
├── .env.local.example       # Template pro env vars
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── README.md
```
