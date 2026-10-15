# Parc Électrique 3D

Carte 3D interactive du parc de production électrique français. Chaque centrale est une colonne : on la
clique pour voir quand elle est appelée dans le merit order du marché spot, comment sa production est
couverte, ce qu'elle vaut, et le JSON qui alimente chaque chiffre.

- **Carte 3D** : France en relief, une colonne par actif (hauteur pleine = production à l'heure choisie,
  partie transparente = puissance). Frise en bas pour changer d'heure et rejouer une journée.
- **Merit order** : un bouton fait s'envoler les colonnes, qui se rangent par coût marginal croissant.
  Ligne de production, prix du modèle, prix spot réel, centrale marginale.
- **Fiche actif** : onglets *Merit* (carte heure × semaine, place dans l'escalier), *Couverture*
  (prix capté, simulateur vente à terme / spot / VNU), *Valo* (VAN, sensibilités), *JSON*. Liste des
  57 tranches EDF par site.
- **Jeu** : XP, niveaux, badges, missions du jour, quiz « qui fixe le prix ? », dispatcher, pari sur le
  prix de demain. La progression reste dans le navigateur.

Le plan de départ et les maquettes sont dans [`docs/plan.html`](docs/plan.html).

## Structure

```
index.html            page unique, aucune étape de build
app/                  modules JavaScript natifs + CSS (MapLibre GL chargé depuis un CDN)
  finance.js          calculs purs : coût marginal, merit order, indicateurs, couverture, VAN
  data.js             chargement des JSON, production par unité (mesurée ou modélisée)
  scene.js            carte 3D        merit.js   vue merit order
  panel.js            fiche actif     game.js    couche de jeu      charts.js  graphiques SVG
data/
  assets.json         catalogue des actifs (coordonnées, puissance, exploitant)
  edf_tranches.json   57 réacteurs EDF
  params.json         hypothèses : combustibles, CO2, rendements, couverture EDF, VNU, WACC
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
