# TrainLab — ton labo d'entraînement

Un cockpit d'entraînement **local** pour les sportifs d'endurance équipés d'une montre Garmin : séances, fichiers FIT, sommeil, HRV et récupération, transformés en tableaux de bord et en analyses (charge et forme, prédictions de course backtestées, profil de coureur, corrélations, modèles de machine learning).

- **100 % local** : tes données restent sur ton ordinateur (base SQLite). Le serveur n'écoute que sur `127.0.0.1`.
- **Sans mot de passe Garmin** : la connexion passe par l'API personnelle officielle de Garmin (une clé révocable que tu crées toi-même).
- **Sans build ni Node** : Python + une interface web servie localement.

> Projet personnel, non affilié à Garmin ni à Strava. Chaque utilisateur se connecte avec **sa propre** clé Garmin (et, en option, sa propre application Strava) et reste responsable du respect de leurs conditions d'utilisation.

## Prérequis

- Python **3.11 ou plus récent** ([python.org](https://www.python.org/downloads/), coche « Add python.exe to PATH » sous Windows).
- Une montre Garmin et un compte Garmin Connect.
- Windows, macOS ou Linux.

## Démarrage (3 étapes)

1. **Installer.** Télécharge le projet (bouton *Code → Download ZIP*, ou `git clone https://github.com/ClementFerrere/TrainLab.git`), puis :
   - Windows : double-clic sur `setup.bat` ;
   - macOS / Linux : `./setup.sh`.

   Un environnement Python isolé (`.venv`) est créé avec les versions exactes de `requirements.txt`.
2. **Lancer.**
   - Windows : double-clic sur `TrainLab.bat` ;
   - macOS / Linux : `./trainlab.sh`.

   L'interface s'ouvre sur <http://127.0.0.1:8765>.
3. **Connecter Garmin.** Dans **Réglages & sources**, suis les 3 étapes :
   - crée une clé sur Garmin Connect (*Paramètres → Personal API Key*, <https://connect.garmin.com/app/settings/personalApiToken>) ;
   - choisis une expiration (90 ou 180 jours conseillé) ;
   - colle la clé dans TrainLab.

   La première synchronisation récupère tout ton historique ; compte quelques dizaines de minutes pour les fichiers FIT.

C'est tout : FC max, zones et FC de repos sont repris automatiquement de Garmin. Tu peux ensuite ajouter tes objectifs de course et ajuster tes paramètres dans **Réglages**.

**Envie de voir avant de connecter ta montre ?**
- Windows : `TrainLab (demo).bat` ;
- macOS / Linux : `./trainlab.sh --demo`.

Ça génère un athlète fictif et ouvre <http://127.0.0.1:8766>.

## Ce que tu peux remplir (tout est optionnel sauf la clé Garmin)

| Où | Quoi |
|---|---|
| Interface → Réglages | **Clé API personnelle Garmin** (obligatoire), objectifs de course, FC max / repos / seuil si tu ne veux pas les valeurs Garmin |
| Fichier `.env` (copie de `.env.example`) | `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` pour l'enrichissement Strava ; `TRAINLAB_HISTORY_YEARS` (profondeur de l'historique sommeil/HRV, 3 ans par défaut) ; `SPORT_PORT` |

## Confidentialité et sécurité

- Tout est stocké dans `data/` sur ta machine : la base `sport.db`, les fichiers FIT originaux et les secrets. Ce dossier est ignoré par git, tout comme `.env`.
- La clé Garmin est vérifiée auprès de Garmin puis stockée dans `data/secrets/`. Ce dossier est restreint à ton compte : ACL Windows, ou `chmod 700` sur macOS/Linux.
- Le jeton d'accès Garmin (24 h) reste en mémoire et n'est jamais écrit sur disque.
- Les seules connexions sortantes vont vers :
  - `personal.connectapi.garmin.com` ;
  - `www.strava.com`, si tu actives Strava ;
  - les tuiles de carte OpenStreetMap, dont seules les coordonnées des tuiles affichées sont demandées, jamais ta trace.
- Le serveur n'écoute que sur `127.0.0.1` et vérifie l'en-tête Host (anti DNS-rebinding). Les requêtes d'écriture exigent un en-tête dédié (anti-CSRF).
- Les dépendances sont épinglées.
- Python utilise le magasin de certificats du système (`truststore`). Ça marche derrière un antivirus ou un proxy qui inspecte le HTTPS, sans jamais désactiver la vérification TLS.
- Pour révoquer l'accès : supprime la clé sur Garmin Connect, puis dans Réglages.

## Sources de données

### Garmin — API personnelle officielle (source principale)

La synchronisation tourne toutes les 30 minutes tant que TrainLab est ouvert, et rattrape automatiquement ce qui manque au lancement suivant. Elle récupère :
- les zones cardio ;
- les activités ;
- le sommeil, la HRV et les résumés quotidiens ;
- le **fichier FIT original** de chaque séance, archivé dans `data/fit/`, d'où sont extraits les streams, les tours, le RPE et les dynamiques de course.

L'API personnelle ne fournit pas *training readiness*, *training status*, l'historique VO2max ni les prédictions Garmin. TrainLab calcule ses propres équivalents (forme TSB, ratio aigu/chronique, VDOT, vitesse critique, readiness maison). Le VO2max est lu dans le fichier FIT.

### Strava — optionnel, fenêtre de 7 jours

La politique API Strava 2026 interdit de conserver les données de l'API plus de 7 jours (§6.2), de les indexer (§5.5) et de les utiliser avec de l'IA (§5.3). TrainLab respecte ces règles :
- les noms, descriptions, chaussures et kudos des séances récentes vont dans une table séparée (`strava_cache`), purgée automatiquement ;
- ces données sont seulement affichées, jamais utilisées dans les calculs.

Configuration (abonnement Strava requis pour créer une application) :
1. Crée une app sur <https://www.strava.com/settings/api> avec *Authorization Callback Domain* = `127.0.0.1`.
2. Copie `.env.example` en `.env` et mets-y tes identifiants.
3. Clique sur *Connecter Strava* dans Réglages.

## Les pages

- **Cockpit** : forme du jour (jauge TSB), readiness du matin, compte à rebours de l'objectif avec prédiction, dernière nuit, semaine en cours, fitness/fatigue, heatmap de l'année, dernière séance.
- **Journal** : volume hebdo par sport, calendrier, table filtrable, mur de tracés. Le détail d'une séance montre :
  - la carte et des streams synchronisés ;
  - les tours, les zones et les meilleurs efforts ;
  - l'analyse de fractionné et la comparaison avec des séances similaires ;
  - un bouton pour marquer une séance comme course officielle ou la supprimer de TrainLab.
- **Profil athlète** : Runner Matrix (6 axes), prédictions de course backtestées, courbe vitesse-durée avec records, durabilité, moteur allure ↔ FC.
- **Charge & objectifs** : PMC (CTL/ATL/TSB), risque (ACWR, monotonie), volume, objectifs, allures Daniels, vitesse critique, efficacité aérobie.
- **Sommeil & récup** : fenêtres de sommeil, phases, HRV avec plage de référence, FC de repos, Body Battery, stress, readiness.
- **Prédictions ML** : HRV, sommeil et FC de repos de la nuit, ressenti de la prochaine séance, alerte HRV, effets mesurés. Chaque modèle est comparé honnêtement à une référence naïve.
- **Labo** : explorateur X/Y avec décalage temporel, matrice de corrélations, découverte automatique (correction de Benjamini-Hochberg).

## Méthodes

**Charge et forme**

| Métrique | Définition |
|---|---|
| Charge (hrTSS) | TRIMP de Banister seconde par seconde sur la FC, normalisé pour qu'1 h au seuil = 100. Repli sur la FC moyenne, puis sur une estimation par sport. |
| CTL / ATL / TSB | Moyennes exponentielles sur 42 j (fitness) et 7 j (fatigue). TSB = CTL − ATL de la veille. |
| ACWR | Charge moyenne 7 j / 28 j. La zone 0,8–1,3 est la « sweet spot » classique : c'est un indicateur discuté, pas un oracle. |
| EF / dérive cardiaque | Vitesse ajustée à la pente (Minetti) par battement ; dérive à allure égale sur les sorties longues. |

**Prédictions de course.** Cinq estimateurs, chacun **backtesté** sur tes propres courses : pour chaque course passée, le modèle est rejoué la veille, avec les seules données antérieures.

| Modèle | Principe |
|---|---|
| VDOT (Daniels) | meilleurs efforts de 1 mile ou plus sur 90 jours |
| Riegel personnel | exposant ajusté sur tes courses |
| Vitesse critique | CS et D′ sur ta courbe vitesse-durée, efforts de 2 à 7 min |
| Moteur cardiaque | ta vitesse à la FC que tu tiens en course, calibrée sur tes courses |
| Séances clés | ta meilleure séance de fractions longues des 6 dernières semaines × ton ratio course / fraction |

L'ensemble est pondéré par l'erreur mesurée sur les courses de distance proche, en leave-one-out. Garmin marque rarement les courses : TrainLab les détecte (distance standard, FC de course, pas d'arrêt), et tu peux corriger à la main.

**Courbe vitesse-durée.** Meilleure vitesse tenue pour chaque durée (15 s → 2 h), ajustée au dénivelé net. Sont écartés :
- les fenêtres trop pentues ou contenant des arrêts ;
- les vitesses au-delà des records du monde ;
- les segments soutenus sans cadence de course (vélo ou véhicule avec la montre en mode course).

**Runner Matrix.** 6 axes notés en percentile de ton propre historique (100 = ton meilleur niveau) : vitesse, endurance, résilience, physiologie, économie, récupération. Avec comparaison à il y a 6 mois et un archétype.

**Readiness.** Écart de la nuit (HRV, FC de repos, sommeil, Body Battery, stress nocturne) à tes 28 jours précédents, plus la divergence entre ton ressenti des séances et ces signaux.

**Machine learning** (`backend/analytics/ml.py`, scikit-learn) :
- seule l'information connue avant l'instant prédit est utilisée ;
- split chronologique : 25 % de test les plus récents, avec un écart de 7 jours ;
- choix du modèle par validation croisée temporelle sur l'entraînement uniquement ;
- comparaison systématique à des références naïves ;
- pour les nuits, on prédit l'écart à la moyenne 7 nuits ;
- les signaux Garmin « de la journée » (stress, Body Battery), qui courent jusqu'à minuit et chevauchent la nuit prédite, sont exclus.

**Convention.** Une nuit est datée du matin où elle se termine (comme Garmin). Les corrélations et les effets mesurés sont descriptifs, pas causaux.

## Pour creuser dans Jupyter

```python
import sqlite3, pandas as pd
con = sqlite3.connect("data/sport.db")   # depuis le dossier du projet
acts = pd.read_sql("select * from activities", con)          # 1 ligne / séance
met  = pd.read_sql("select * from activity_metrics", con)    # charge, zones, EF
well = pd.read_sql("select * from daily_wellness", con)      # 1 ligne / jour (sommeil, HRV, FC repos…)
```

Les streams sont dans `streams.data` (JSON compressé zlib) : `json.loads(zlib.decompress(blob))`. Les fonctions d'analyse sont réutilisables, par exemple `backend.analytics.load.daily_frame()` et `backend.analytics.lab.daily_features()`.

## Architecture

```
backend/   FastAPI (127.0.0.1 uniquement) + SQLite
  garmin.py        client de l'API personnelle Garmin + synchronisation
  fit.py           parsing FIT (SDK officiel Garmin) + meilleurs efforts
  strava.py        OAuth + cache 7 jours conforme
  analytics/       charge, performance, prédictions, profil, readiness, fractionné, labo, ML
frontend/  HTML/JS sans build, ECharts + Leaflet embarqués (aucun CDN)
scripts/   demo_data.py (athlète fictif pour la démo et les tests)
tests/     synchro Garmin simulée + test de tous les endpoints
data/      créé au premier lancement — tes données, jamais versionné
```

Tests : `python scripts/demo_data.py`, puis `python tests/test_api_smoke.py` et `python tests/test_garmin_pipeline.py` (avec le Python de `.venv`).

La documentation de l'API personnelle Garmin est sur <https://developer.garmin.com/gc-developer-program/personal/>.

## Licence

Voir [LICENSE](LICENSE).
