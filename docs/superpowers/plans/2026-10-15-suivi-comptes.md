# Suivi des comptes — plan d’implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une application Electron locale qui remplace le classeur de dépenses et d’encaissements.

**Architecture:** Le processus principal tient une base SQLite (`node:sqlite`) et applique les règles du document de conception. La fenêtre envoie des actions par un pont preload, sans accès à la base. Les calculs de synthèse sont des fonctions pures appelées par la couche `ledger`.

**Tech Stack:** TypeScript, Electron, `node:sqlite`, exceljs, vitest, esbuild.

## Global Constraints

- Une base pour toutes les années. Les tableaux affichent une année.
- Montants en euros, stockés en centimes. Dépense négative, encaissement positif.
- Pas d’immobilier, pas de lignes de supports, pas de suppression définitive, pas d’autre devise.
- La base vit dans les données de l’application.
- Si le fichier ne s’ouvre pas, ne pas créer une base vide à la place.
- L’ouverture d’une base est explicite (créer ou désigner).

---

### Task 1: Montants, dates, lecture de fichier

**Files:**
- Create: `src/money.ts`, `src/dates.ts`, `src/parse-file.ts`
- Test: `tests/parse.test.ts`

Produit `parseAmount`, `parseDate`, `readTabularFile`, `classifyImport`.

- [x] Tests des montants (signe, débit/crédit, milliers, zéro, illisible), des dates, du CSV, de l’Excel, des doublons par rang.
- [x] Implémentation minimale jusqu’au vert.

### Task 2: Base et règles métier

**Files:**
- Create: `src/db.ts`, `src/summary.ts`, `src/ledger.ts`
- Test: `tests/ledger.test.ts`

Produit le schéma, `createDatabase`, `openDatabase` (lecture seule de contrôle, aucun fichier créé si échec), et l’API comptes, catégories, import, pointage, synthèses.

- [x] Tests de la liste de vérification du document de conception, sur une base temporaire.
- [x] Implémentation jusqu’au vert.

### Task 3: Fenêtre Electron

**Files:**
- Create: `src/main.ts`, `src/preload.ts`, `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/renderer.ts`, `build.mjs`

Écrans : démarrage, tableau global, comptes, synthèse, import avec aperçu, pointage, catégories, soldes mensuels, export.

- [x] `npm test` vert et `npm run build` réussi.

### Task 4: Parcours à la main

L’application démarre. Le parcours à la main reste à faire dans la fenêtre : importer un CSV et un Excel, pointer, saisir un solde, lire les deux tableaux, annuler l’import, exporter une copie.
