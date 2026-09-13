# Paquet PR — connecteur OANDA pour Vibe-Trading (upstream)

Contenu prêt à soumettre pour un PR upstream sur
`HKUDS/Vibe-Trading` : un connecteur **OANDA v20** complet (lectures +
ordres) qui ouvre le **Forex paper** (`fxTrade Practice`, inscription par
e-mail, sans pièce d'identité ni données fiscales) et le Forex live.

```
agent/src/trading/connectors/oanda/   ← les 3 fichiers du connecteur
REGISTRY.md                            ← les 3 lignes d'enregistrement (2 fichiers)
PR-BODY.md                             ← description du PR, prête à coller
local-plugin/                          ← plugin read-only installable AUJOURD'HUI
```

## Pourquoi ce connecteur

- Vibe-Trading a le vocabulaire Forex dans le mandate gate depuis v0.1.12,
  mais aucun connecteur retail-Forex : `mt5` est Windows-only. OANDA est
  le standard : compte **Practice** gratuit (e-mail + pays, pas de KYC
  documentaire), API REST v20 complète, historique depuis 2005.
- Le connecteur est **stdlib-only** (aucune dépendance nouvelle) : auth
  par token bearer + `account_id`, config dans
  `~/.vibe-trading/oanda.json` (comme `alpaca.json`).

## Soumettre le PR upstream (2 minutes)

```bash
git clone https://github.com/HKUDS/Vibe-Trading
cd Vibe-Trading
git checkout -b feat/oanda-connector
# 1) copier les 3 fichiers du connecteur :
cp -r <ce-repo>/deploy/oci/upstream/oanda-vibe-trading-pr/agent/src/trading/connectors/oanda \
      agent/src/trading/connectors/
# 2) appliquer les 3 lignes de REGISTRY.md (profiles.py + service.py)
# 3) vérifier :
python -m compileall agent/src/trading/connectors/oanda
# 4) commit + push sur votre fork, puis :
gh pr create --repo HKUDS/Vibe-Trading \
  --title "feat(connectors): OANDA v20 REST connector (practice + live)" \
  --body-file deploy/oci/upstream/oanda-vibe-trading-pr/PR-BODY.md
```

> **Note** : ce workspace ne peut pas pousser vers `HKUDS/Vibe-Trading`
> (crédential GitHub limité à ce dépôt) — d'où le paquet prêt à
> soumettre. Le PR s'ouvre depuis votre compte en 4 commandes.

## En attendant le merge : plugin read-only local (utilisable aujourd'hui)

Vibe-Trading permet d'installer des connecteurs locaux **read-only**
(`account.read` + `positions.read`) sans passer par upstream :

```bash
# sur la machine où tourne vibe-trading (ou dans le conteneur) :
vibe-trading connector validate deploy/oci/upstream/oanda-vibe-trading-pr/local-plugin
vibe-trading connector install   deploy/oci/upstream/oanda-vibe-trading-pr/local-plugin
vibe-trading connector check oanda-practice-readonly   # après avoir créé la connection
```

Utile immédiatement pour les commissions de recherche Hermès
(`mode: RESEARCH`) sur le compte Practice. L'exécution d'ordres, elle,
nécessite le connecteur complet : tant que le PR n'est pas mergé, pointez
le build de l'image sur votre fork —
`VIBE_TRADING_VERSION=feat/oanda-connector` dans
`deploy/oci/vibe-trading.Dockerfile`.

## Clés OANDA (pratique)

1. https://account.oanda.com/demo/ → compte **fxTrade Practice** (e-mail
   + pays ; **aucune pièce d'identité / données fiscales**).
2. Dans fxTrade Practice : « Manage API Access » → créer un **Personal
   Access Token** (hôte practice).
3. Récupérer l'**account id** (numéro sur la page « Account Summary »).
4. Écrire `~/.vibe-trading/oanda.json` (volume `vibe_data`) :
   ```json
   { "api_key": "<token>", "account_id": "<id>", "profile": "practice" }
   ```
5. `vibe-trading connector check oanda-practice-trade`.

## Test end-to-end avec le bridge

Après merge (ou build depuis votre fork) :

```bash
# .env : basculer le bridge sur OANDA practice
BRIDGE_CONNECTOR=oanda-practice-trade
docker compose up -d bridge
# directive : EUR/USD 1000 units (fractional autorisé, règle 5 du prompt)
#   execution_request: { "symbol": "EUR_USD", "side": "BUY", "qty": 1000, "order_type": "market" }
```

Le fill check du bridge compare les positions avant/après — les unités
OANDA étant signées, un BUY apparaît comme quantity positive dans
`connector positions` (le parseur bridge accepte les symboles `EUR_USD`).

## Limites connues (dites-les dans le PR)

- Non testé contre l'API réelle dans ce paquet (pas de credentials) —
  le plan de test du PR-BODY couvre `connector check` → `account` →
  `positions` → `quote` → `place_order` paper.
- `notional` n'est pas supporté (v20 n'a pas de champ notional pour le
  spot FX) : passer `quantity` en unités de la devise de base.
- Le catalogue de credentials du Web UI (`connections.py`) n'est pas
  étendu (config JSON legacy suffit — voir REGISTRY.md §3).