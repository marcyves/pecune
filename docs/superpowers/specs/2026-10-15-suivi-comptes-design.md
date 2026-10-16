# Suivi des comptes familiaux

Date : 2026-10-15

Application Electron qui remplace le classeur « Tableau dépenses et encaissements ». Elle tourne sur le Mac, hors ligne. Le code vit dans `/Users/marc/Projects/comptes-famille`, en dehors du wiki.

## Périmètre

Cette version couvre :

- les banques et les comptes : ajouter, modifier, archiver
- l’import CSV ou Excel, avec une correspondance de colonnes mémorisée par compte
- le pointage : attribuer une catégorie à chaque opération
- la synthèse d’un compte : familles, puis catégories, en colonnes par mois
- le tableau global : une ligne par compte, groupée par banque, avec dépenses, encaissements et soldes
- les comptes sans relevé : saisie du solde de fin de mois

Hors de cette version :

- l’immobilier et l’IFI
- le détail des supports (Cachemire, PEA, ligne par ligne). Plus tard, une liste de positions pourra s’ajouter à un compte sans modifier les opérations ni les soldes
- la suppression définitive d’un compte, d’une catégorie ou d’une opération isolée
- une devise autre que l’euro

## Architecture

La fenêtre Electron affiche les écrans et envoie des actions. Le processus principal tient la base SQLite, lit les fichiers et applique les règles de calcul. La fenêtre n’accède pas à la base. Le plan d’implémentation choisit la bibliothèque d’interface, dans ce cadre.

Une seule base couvre toutes les années. Les tableaux affichent une année à la fois.

Le fichier de base est dans les données de l’application sur le Mac. Il n’est pas dans Dropbox. Une action « Exporter une copie » écrit un second fichier à l’emplacement choisi. Si le fichier de base ne s’ouvre pas, l’application le dit et n’en crée pas un vide à la place. L’utilisateur désigne le fichier existant, ou crée une base nouvelle par une action explicite.

## Données

Les montants sont en euros. Une dépense est négative, un encaissement est positif. Une date est un jour calendaire, sans heure.

**Banque.** Nom, unique. Elle sert à regrouper le tableau global. On la choisit ou on la crée en éditant un compte. Une banque sans compte n’apparaît plus.

**Compte.** Nom unique dans la base, banque, archivé ou non, type.

- *Relevé.* Correspondance de colonnes mémorisée, et un solde d’ouverture (montant et date). La date est le jour où ce solde est vrai en début de journée. Les opérations de ce jour et des jours suivants s’ajoutent ensuite.
- *Solde.* Pas d’opérations. Un montant de fin de mois, saisi à la main.

Archiver un compte le retire des listes et des tableaux. Ses opérations et ses soldes restent. Le modifier permet de le réactiver.

**Famille.** Nom unique, ordre d’affichage, nature : dépense ou encaissement.

**Catégorie.** Nom unique dans tout le plan, famille, ordre dans la famille. Le pointage et les tableaux affichent ce nom. Il n’y a pas de code.

Renommer une catégorie met à jour les opérations qui la portent. Archiver la retire des listes de pointage. Les opérations déjà pointées continuent de l’afficher.

**Opération.** Compte à relevé, date, libellé, montant signé, catégorie éventuelle, lot d’import. La catégorie est vide tant que la ligne n’est pas pointée.

**Solde mensuel.** Compte de type solde, mois, montant de fin de mois.

**Lot d’import.** Compte, date d’import, nom du fichier, lignes associées.

## Écrans

Barre latérale : Tableau global, Comptes, Pointage, Catégories. Ouvrir un compte montre sa synthèse, ses opérations ou ses soldes, et ses imports.

**Comptes.** Liste groupée par banque. Ajouter, modifier, archiver, avec confirmation pour l’archive. Pour un compte à relevé : colonnes (date, libellé, et soit un montant signé, soit un débit et un crédit), format de date, séparateur décimal, solde d’ouverture. Pour un compte solde : douze cases pour l’année affichée. Le mouvement calculé est affiché, pas saisi.

**Import.** Choisir le compte à relevé, puis un fichier CSV ou Excel. S’il y a plusieurs feuilles, en choisir une ; ce choix n’est pas mémorisé. La première ligne est l’en-tête. La correspondance enregistrée identifie les colonnes par le texte de l’en-tête. L’aperçu classe chaque ligne : prête, déjà présente, ou rejetée. Rien n’est écrit avant confirmation. La confirmation n’écrit que les lignes prêtes.

**Pointage.** Opérations sans catégorie, pour un compte ou pour tous. Une opération négative ne propose que les catégories de dépense. Une opération positive ne propose que les catégories d’encaissement. Si ce compte a déjà une opération pointée avec exactement le même libellé, la dernière catégorie attribuée à ce libellé est présélectionnée. On peut changer la catégorie d’une ligne déjà pointée.

**Catégories.** Ajouter, renommer, réordonner et archiver des familles et des catégories. Confirmation pour l’archive.

**Synthèse du compte**, année affichée.

- Compte à relevé. Deux blocs, dépenses puis encaissements. Dans chaque bloc : les familles de cette nature, puis leurs catégories, en colonnes par mois. Le montant d’une catégorie garde son signe. Le total de famille est la somme des valeurs absolues de ses catégories. Le total du bloc est positif. Chaque bloc a une ligne « Non pointé » : pour les dépenses, la valeur absolue des montants négatifs sans catégorie ; pour les encaissements, la somme des montants positifs sans catégorie. Sous les blocs : le solde d’ouverture, puis le solde de fin de chaque mois.
- Compte solde. Pas de grille de catégories. Les douze soldes saisis, et le mouvement de chaque mois.

**Tableau global**, année affichée. Trois blocs : dépenses, encaissements, soldes. Dans chaque bloc, les banques, puis une ligne par compte non archivé. Totaux de banque et total général en bas de chaque bloc. Un virement reste une dépense sur un compte et un encaissement sur l’autre.

## Calcul

**Compte à relevé, pour un mois.**

- Dépense affichée = valeur absolue de la somme des montants négatifs du mois, pointés ou non.
- Encaissement affiché = somme des montants positifs du mois.
- Solde de fin de mois = solde d’ouverture + somme des montants signés du jour d’ouverture jusqu’à la fin de ce mois.
- Un mois sans opération, et dont le début est le jour d’ouverture ou après, a une dépense et un encaissement à zéro. Son solde est celui de la fin du mois précédent.
- Un mois entièrement antérieur au jour d’ouverture a des dépenses et des encaissements à zéro, et un solde vide.
- Janvier reprend le solde de fin décembre de l’année précédente quand il peut être calculé.
- Sans solde d’ouverture, dépenses, encaissements et catégories s’affichent. La ligne de solde indique qu’il manque, et ne montre pas de montant. Le tableau global laisse vides les cellules de solde de ce compte.

**Compte solde, pour un mois.**

- Le solde affiché est le montant saisi.
- Le premier mois saisi n’a pas de mouvement.
- Si le mois précédent n’a pas de solde, le mouvement est vide. Il n’est pas calculé avec un zéro. Les cellules de dépense et d’encaissement du tableau global restent vides. Le solde saisi, lui, s’affiche.
- Si les deux soldes existent : l’écart est solde du mois − solde précédent. Un écart négatif est une dépense égale à sa valeur absolue, et un encaissement à zéro. Un écart positif est un encaissement, et une dépense à zéro. Un écart nul donne zéro des deux côtés.
- Janvier utilise le solde de décembre de l’année précédente, s’il a été saisi.

**Totaux de banque et total général.** Ils additionnent les cellules qui contiennent un nombre. Une cellule vide n’est pas un zéro, et le total s’affiche quand même.

## Import

La correspondance mémorisée contient : nom de colonne date, nom de colonne libellé, soit le nom de la colonne montant signé, soit les noms des colonnes débit et crédit, le format de date, le séparateur décimal (virgule ou point). La modifier ne réécrit pas les lignes déjà importées. Elle sert aux imports suivants.

Le montant enregistré :

- colonne signée : le nombre lu, avec son signe
- colonne débit : l’opposé de la valeur absolue lue
- colonne crédit : la valeur absolue lue

Espaces et apostrophes sont retirés. Si la virgule est le séparateur décimal, les points sont retirés. Si le point est le séparateur décimal, les virgules sont retirées. Ce qui reste et n’est pas un nombre rend la ligne rejetée.

Lecture :

- CSV : essai UTF-8, puis Windows-1252. Le séparateur est celui qui découpe l’en-tête en colonnes cohérentes parmi virgule, point-virgule et tabulation.
- Excel : la feuille choisie. Les dates Excel déjà typées date sont lues comme des jours. Les dates stockées en texte suivent le format enregistré.

Une ligne est rejetée, et listée avec son numéro, quand :

- la date ne suit pas le format enregistré
- le montant est vide, nul, ou illisible
- le débit et le crédit sont tous les deux remplis
- la date est antérieure au jour du solde d’ouverture, lorsque ce solde existe

Un en-tête attendu absent interrompt l’import : rien n’est écrit, l’écran montre les en-têtes trouvés et celui qui manque.

La clé d’une opération est le compte, la date, le libellé et le montant. Deux opérations de même clé sont toutes les deux conservées. Dans un fichier, les lignes de même clé sont numérotées dans l’ordre de lecture, à partir de 1. La ligne de rang k est déjà présente si la base contient au moins k opérations de cette clé. Elle est prête si la base en contient moins de k. Un second import du même fichier ne réécrit donc rien, et une vraie opération en double dans un seul fichier est gardée.

Chaque confirmation crée un lot. Annuler un lot retire toutes ses lignes, pointées ou non, après avoir affiché leur nombre et demandé confirmation. On ne retire pas une ligne seule.

## Vérification

Automatique, sur une base temporaire, sans fenêtre :

- créer un compte relevé et un compte solde, les modifier, archiver : le compte archivé sort des tableaux, ses lignes restent
- enregistrer une correspondance et la réappliquer ; un montant signé et un couple débit/crédit produisent le même montant en base
- l’aperçu sépare prêtes, déjà présentes et rejetées ; avant confirmation la base ne change pas ; annuler un lot retire ses lignes
- deux lignes identiques dans un même fichier sont toutes les deux importées ; un second fichier identique ne les réimporte pas
- pointer une ligne, retrouver la catégorie sur le même libellé du même compte, puis la changer ; une opération négative ne propose pas une catégorie d’encaissement
- archiver une catégorie la retire du pointage ; les opérations déjà pointées gardent son nom ; la renommer met ces opérations à jour
- synthèse d’un compte relevé : signes des catégories, totaux de famille positifs, ligne « Non pointé », solde à partir du solde d’ouverture, indication quand ce solde manque, report du solde d’un mois sans opération
- compte solde : pas de mouvement au premier mois, pas de mouvement si le mois précédent est vide, janvier s’appuie sur décembre précédent, écart négatif en dépense et écart positif en encaissement
- tableau global : trois blocs, banques, totaux qui ignorent les cellules vides, virement compté des deux côtés
- les tableaux d’une année n’incluent pas les opérations d’une autre année ; le solde de janvier, lui, peut dépendre de décembre précédent

À la main, application ouverte : importer un CSV et un Excel, pointer quelques lignes, saisir un solde de fin de mois, lire les deux tableaux, annuler l’import, exporter une copie de la base.
