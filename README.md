# Pécune

Suivi des comptes sur Mac, en local. Pas de compte en ligne, pas de serveur : la base reste sur la machine.

## Comptes

Trois types.

- **Courant.** Import d’un relevé CSV ou Excel, puis pointage : chaque opération reçoit une catégorie. Les dépenses et les encaissements se lisent par famille, mois par mois.
- **Épargne.** Un solde initial, des mouvements saisis à la main, des virements vers les autres comptes. Le solde de fin de mois est calculé.
- **Titre.** Les lignes détenues, avec la quantité et la valeur unitaire, plus le disponible au comptant.

Un virement interne reste une dépense d’un côté et un encaissement de l’autre. Si l’autre relevé a déjà la ligne, Pécune la propose au lieu d’en créer une seconde.

## Tableau de l’année

Les comptes sont groupés par banque. Trois vues : soldes, dépenses, encaissements.

## Données

Une seule base SQLite, en euros, pour toutes les années. Les tableaux affichent une année à la fois.

Au premier lancement, on crée une base ou on en ouvre une. Elle est enregistrée dans les données de l’application. **Exporter une copie** en écrit une autre, à l’endroit choisi. Rien n’est envoyé.

Si le fichier ne s’ouvre pas, Pécune le dit et n’en crée pas un vide à la place.

## Lancer

Node.js 22 ou plus récent. L’application utilise le module SQLite intégré à Node.

```bash
npm install
npm start
```

## Développement

```bash
npm run typecheck
npm run build
```
