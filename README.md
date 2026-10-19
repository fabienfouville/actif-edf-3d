# Parc Électrique 3D

Carte 3D interactive du parc de production électrique français. Chaque centrale est une colonne : on la
clique pour voir quand elle est appelée dans le merit order du marché spot, comment sa production est
couverte, ce qu'elle vaut, et le JSON qui alimente chaque chiffre.

- **Maquette 3D** : France en plateau blanc, une seule maquette par filière (une centrale nucléaire pour tout le nucléaire, un barrage pour tout l'hydraulique…), animée selon la production ; un anneau au sol indique la charge,
  et la fiche liste les sites et tranches. Frise en bas pour changer d'heure et rejouer une journée.
- **Merit order** : un bouton fait s'envoler les colonnes, qui se rangent par coût marginal croissant.
  Ligne de production, prix du modèle, prix spot réel, centrale marginale.
- **Fiche actif** : onglets *Merit* (carte heure × semaine, place dans l'escalier), *Prévision*
  (courbe forward horaire, forme journalière, contrôle produit par produit), *Pricing* (interruption,
  Pmin, must-run, Pmax, limitation ; export JSON pour Astral / M2F), *Couverture* (prix capté,
  simulateur vente à terme / spot / VNU), *Valo* (VAN, sensibilités), *JSON*. Liste des 57 tranches EDF par site.
- **Recherche** : barre en haut à gauche (raccourci `/`) sur les centrales, tranches, communes et exploitants.
- **Jeu** : XP, niveaux, badges, missions du jour, quiz « qui fixe le prix ? », dispatcher, pari sur le
  prix de demain. La progression reste dans le navigateur.

Le plan de départ et les maquettes sont dans [`docs/plan.html`](docs/plan.html).

## Structure

```
index.html            page unique, aucune étape de build
app/                  modules JavaScript natifs + CSS (MapLibre GL chargé depuis un CDN)
  finance.js          calculs purs : coût marginal, merit order, indicateurs, couverture, VAN
  forward.js          courbe forward horaire (HPFC), heure de Paris, coût marginal à terme
  pricing.js          pricing des contraintes, VNU, scénarios, export JSON Astral / M2F
  data.js             chargement des JSON, production par unité (mesurée ou modélisée)
  scene.js            carte 3D        merit.js   vue merit order
  panel.js            fiche actif     game.js    couche de jeu      charts.js  graphiques SVG
data/
  assets.json         catalogue des actifs (coordonnées, puissance, exploitant)
  edf_tranches.json   57 réacteurs EDF
  params.json         hypothèses : combustibles, CO2, rendements, couverture EDF, VNU, WACC
  market.json         produits forward élec (base, pointe) et gaz PEG, revenu du parc, Pmin par défaut
  meta.json           état des sources et liste des mois disponibles
  live.json           48 dernières heures au pas de 15 min
  series/AAAA-MM.json séries horaires : prix, mix national, production par groupe
  geo/regions.json    contours des régions (IGN / INSEE, Licence Ouverte)
pipeline/             Python, bibliothèque standard uniquement
  update.py           collecte et écriture de data/
  sources.py          éCO2mix (ODRÉ), ENTSO-E, Energy-Charts, RTE Data
  demo.py             données de démonstration synthétiques
tests/                tests JS (node --test) et Python (unittest)
```

## Données

| Source | Contenu | Accès |
|---|---|---|
| RTE éCO2mix (ODRÉ) | mix national par filière, consommation | libre, sans clé |
| ENTSO-E Transparency | prix day-ahead France | jeton gratuit : secret `ENTSOE_TOKEN` |
| Energy-Charts (Fraunhofer ISE) | prix day-ahead France, plan B sans clé | prix FR à usage privé |
| RTE Data | production réalisée par groupe ≥ 100 MW | compte gratuit : `RTE_CLIENT_ID`, `RTE_CLIENT_SECRET` |

Sans identifiants RTE, la production de chaque centrale est estimée comme une part du mix national de
sa filière, et la fiche l'indique. Les prix du gaz, du CO2 et la couverture EDF sont des hypothèses
réglables dans `data/params.json` et dans l'app.

**Tant que le pipeline n'a pas tourné, le site affiche des données de démonstration synthétiques**
(bandeau « DÉMO »). Le premier passage réel supprime ces fichiers et reprend 400 jours d'historique.

## Mise en ligne (GitHub Pages)

1. Fusionner cette branche dans `main` (les tâches planifiées de GitHub ne tournent que sur la branche par défaut).
2. *Settings → Pages → Source* : choisir **GitHub Actions**. Sur un compte gratuit, Pages exige un dépôt public.
3. Optionnel, *Settings → Secrets and variables → Actions* : ajouter `ENTSOE_TOKEN`, `RTE_CLIENT_ID`, `RTE_CLIENT_SECRET`.
4. *Actions → Données et site → Run workflow* avec `days = 400` pour le premier remplissage.

Ensuite, le workflow tourne toutes les heures : il récupère les 3 derniers jours, republie le site et
commite l'historique une fois par jour.

### Obtenir les clés

- **ENTSO-E** : créer un compte sur transparency.entsoe.eu, puis écrire à transparency@entsoe.eu avec
  l'objet « Restful API access » et l'adresse du compte. Le jeton apparaît ensuite dans *My account settings*.
- **RTE Data** : créer un compte sur data.rte-france.com, s'abonner à l'API *Actual Generation*, créer
  une application et copier son *client ID* et son *client secret*.

## En local

```
python3 pipeline/update.py --demo     # régénère les données de démo
python3 pipeline/update.py --days 3   # vraies données (réseau requis)
python3 -m http.server 8000           # puis http://localhost:8000
npm test && python3 -m unittest discover -s tests
```

## Limites

Le merit order est un modèle simplifié : il empile les capacités françaises par coût marginal et ignore
le couplage avec les pays voisins, les contraintes de démarrage et la gestion des stocks hydrauliques.
La couverture et la valorisation sont des ordres de grandeur pédagogiques, pas une évaluation financière.

## Prévision et pricing (fusion de Parc EDF Command)

Besoin de départ : pricer des interruptions ou des impositions à Pmin / Pmax sur des centrales EDF.
Règle de méthode : thermique hors nucléaire → intrinsèque ici, extrinsèque dans Astral + M2F ;
nucléaire → déterministe avec le VNU ; hydraulique et production fatale → méthode à définir.

**Courbe forward horaire** (`app/forward.js`, `buildHPFC`), de novembre 2026 à décembre 2029 :

1. produits liquides seulement (`data/market.json`) : Cal-27/28/29, Q1 à Q3-27 ; Q4-27 déduit par
   arbitrage Cal-27 − Q1..Q3, en base et en pointe, pondéré en heures ;
2. niveau mensuel : trimestre ou calendaire réparti par une saisonnalité mensuelle standard ;
   nov. et déc. 26 sans cotation → spot moyen des 30 derniers jours ;
3. forme horaire par mois × (semaine, week-end), estimée sur le spot réel ENTSO-E du site ;
4. recalage additif de chaque mois, puis calage exact base et pointe de chaque produit
   (vérifié par `tests/forward.test.mjs` et affiché dans l'onglet Prévision).

Toute la courbe est à l'heure de Paris : pointe = jours ouvrés 8 h-20 h locales, changements d'heure
compris (2027 = 8 760 h, 2028 = 8 784 h).

**Pricing** (`app/pricing.js`, `priceIt`) : Σ horaire (production de référence − production
contrainte) × valeur du MWh. Thermique : en marche si F > CMg, CMg avec le gaz PEG du mois.
Nucléaire : référence = Pn si F ≥ CMg, sinon Pmin ; valeur marginale après VNU selon le revenu du
parc de l'année (2026 et 2027 : estimation CRE ; ensuite Cal base, modifiable) :

- bande 1 (s1 < R ≤ s2) : F − 50 % × (F − s1) ;
- bande 2 (R > s2) : F − 50 % × (s2 − s1) − 90 % × (F − s2).

Import de scénarios : `{"start": "2027-01-01T00:00", "paths": [[€/MWh horaires], …]}` (heure de Paris
si pas de fuseau) → moyenne sur les trajectoires et extrinsèque. Export : JSON `parc3d.pricing/1`
(actif, unités, contrainte, période, méthode, résultat avant/après VNU, produits, combustibles, et en
option la courbe horaire F et CMg).
