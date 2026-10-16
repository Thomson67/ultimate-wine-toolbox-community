# Déployer le service communautaire sur Cloudflare Free

Le dépôt des profils est `Thomson67/ultimate-wine-toolbox-community` et le Worker préparé
est `https://uwt-community-api.roeckel.workers.dev`. Aucun secret n'est présent dans ce dépôt.
Le service n'est pas opérationnel tant que les étapes ci-dessous ne sont pas terminées.

## Mise à jour depuis la première version (Worker version 1)

Votre clé validateur et les secrets Cloudflare restent valables. Les propositions déjà
envoyées sont conservées.

1. Dans la console D1 `uwt-community`, réexécuter le **nouveau fichier schema.sql complet**.
   Il ajoute `pairings`, `devices` et `device_sessions` sans supprimer les tables existantes.
2. Remplacer le code du Worker par le nouveau `dist/worker.js`, puis **Deploy**.
3. Vérifier `/health` : `version` doit valoir **2** et `configured` doit rester `true`.
4. Installer la version de test mise à jour de la Toolbox.
5. Ouvrir **Espace validateur** sur Batocera : une adresse et un code comme `K7MP-4RXN` apparaissent.
6. Sur votre PC ou téléphone, ouvrir <https://uwt-community-api.roeckel.workers.dev/pair>.
7. Coller la **clé validateur** dans la page et se connecter. Elle n'est plus saisie sur Batocera.
8. Saisir le code affiché sur Batocera, cliquer sur **Vérifier le code**, puis vérifier le nom de l'appareil.
9. Cocher si souhaité **Autoriser cet appareil pendant 30 jours**, puis confirmer l'autorisation.
10. La Toolbox ouvre automatiquement l'espace validateur. Pour interrompre l'appairage,
    cliquer **Annuler** sur Batocera. Le code expire après cinq minutes.

Les appareils mémorisés apparaissent en bas de la page PC. **Révoquer** bloque leurs
sessions ouvertes et leurs connexions futures. La Toolbox possède aussi une option
**Oublier l'accès validateur de ce Batocera**. Une erreur réseau lors de l'oubli local
peut nécessiter une révocation complémentaire sur la page PC.

Sans mémorisation, l'accès dure 30 minutes au maximum et se termine à la sortie du menu.
Avec mémorisation, un jeton propre à cet appareil est conservé localement avec des droits
0600 ; il permet d'ouvrir des sessions de 30 minutes pendant une durée fixe de 30 jours.
La clé principale n'est jamais stockée sur Batocera. Un appareil appairé ne peut pas en
autoriser d'autres ni accéder à la gestion des appareils.

La page PC utilise une session en mémoire : fermer/recharger la page demande de se
reconnecter. Elle ne sauvegarde pas la clé ni le jeton dans le stockage du navigateur.
Le code court ne constitue pas un mot de passe et n'accorde pas de droits à lui seul.
Ce mécanisme d'appairage n'est pas une authentification à deux facteurs.

## 1. Installer les tables dans D1

Dans Cloudflare → Storage & databases → D1 → `uwt-community` → Console :

1. Ouvrir [schema.sql](schema.sql), puis **Raw** sur GitHub.
2. Copier le contenu complet et l'exécuter dans la console D1.
3. Vérifier l'apparition des tables `submissions`, `sessions` et `rate_limits`.

Ce script crée uniquement les tables manquantes ; il ne supprime aucune donnée.

## 2. Vérifier la liaison du Worker

Cloudflare → Workers & Pages → `uwt-community-api` → Bindings :

- Type : D1 database.
- Nom de la liaison : **DB**, en majuscules.
- Base : `uwt-community`.

## 3. Générer la clé validateur sur son PC Windows

Ouvrir **Windows PowerShell** sur son PC, puis exécuter ce bloc. Ne pas utiliser un mot
de passe inventé à la place : la vérification SHA-256 est conçue pour une clé aléatoire de
256 bits, ce qui évite un calcul de mot de passe coûteux dans l'offre Workers Free.

```powershell
$uwtBytes = New-Object byte[] 32
$uwtRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$uwtRng.GetBytes($uwtBytes)
$uwtRng.Dispose()
$uwtKey = ([System.BitConverter]::ToString($uwtBytes)).Replace('-', '').ToLowerInvariant()
$uwtSha = [System.Security.Cryptography.SHA256]::Create()
$uwtHash = ([System.BitConverter]::ToString($uwtSha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($uwtKey)))).Replace('-', '').ToLowerInvariant()
$uwtSha.Dispose()
Write-Host "CLE VALIDATEUR (a conserver dans votre gestionnaire de mots de passe) : $uwtKey"
Write-Host "ADMIN_KEY_HASH (a mettre dans Cloudflare) : $uwtHash"
```

Conserver la **CLE VALIDATEUR** dans un gestionnaire de mots de passe : c'est elle que l'on
saisira dans la Toolbox. Chaque valeur comporte 64 caractères hexadécimaux minuscules.
Ne transmettre ni l'une ni l'autre dans une conversation ou une issue.

Dans le Worker → Settings → Variables and Secrets → Add :

- Type : **Secret**.
- Nom : `ADMIN_KEY_HASH`.
- Valeur : la seconde valeur affichée par PowerShell, sans le libellé.

Le Worker conserve uniquement l'empreinte de la clé, pas la clé elle-même.
Tous les validateurs possédant cette clé ont les mêmes droits.

## 4. Créer le jeton GitHub limité au catalogue

Dans GitHub → photo de profil → Settings → Developer settings → Personal access tokens
→ Fine-grained tokens → Generate new token :

1. Nom : `UWT Community Cloudflare`.
2. Resource owner : `Thomson67`.
3. Choisir une expiration et prévoir son renouvellement.
4. Repository access : **Only select repositories**.
5. Sélectionner uniquement **ultimate-wine-toolbox-community**.
6. Repository permissions → **Contents : Read and write**. Metadata en lecture est automatique.
7. Ne donner aucune permission sur le dépôt du code de la Toolbox, ni sur les workflows.
8. Générer le jeton et le copier directement dans le Worker comme **Secret** nommé `GITHUB_TOKEN`.

Ne pas publier ce jeton, le mettre dans Batocera ou le communiquer dans le chat.
Le dépôt cible et la branche `main` sont fixés dans le code du service.

## 5. Installer le code du Worker

1. Ouvrir [dist/worker.js](dist/worker.js), puis **Raw** sur GitHub.
2. Copier tout le fichier. Il contient déjà ses dépendances ; aucune installation Node n'est nécessaire.
3. Dans Cloudflare → Worker `uwt-community-api` → **Edit code**, sélectionner le fichier principal.
4. Remplacer le code Hello World par le contenu copié, puis cliquer sur **Deploy**.
5. Vérifier que la liaison DB et les deux secrets sont toujours présents.

Ouvrir ensuite :

<https://uwt-community-api.roeckel.workers.dev/health>

La réponse attendue contient :

```json
{"service":"uwt-community","version":2,"configured":true,"profile_limit":65536}
```

`configured: true` confirme la présence de la liaison et des secrets, pas encore la validité
du jeton GitHub ni celle du schéma D1. Les tests de bout en bout ci-dessous les vérifieront.

## 6. Activer le nettoyage quotidien

Worker → Settings → Trigger Events → Cron Triggers → Add :

```text
17 3 * * *
```

Il s'exécute chaque jour à 03:17 UTC. Il supprime les sessions et compteurs expirés,
les propositions en attente de plus de 30 jours et les historiques traités de plus de 30 jours.
Les profils acceptés restent dans GitHub. Le nettoyage n'affecte pas le catalogue public.

## 7. Installer la version de test de la Toolbox

Installer la révision de la branche `feature/antimicrox-native` fournie avec cette mise à jour.
La configuration par défaut pointe vers ce nouveau dépôt et ce Worker. Une configuration
personnalisée existante dans `config/community-source.json` est conservée : si elle désigne
l'ancien dépôt, la remplacer explicitement par :

```json
{
  "repository": "Thomson67/ultimate-wine-toolbox-community",
  "ref": "main",
  "api": "https://uwt-community-api.roeckel.workers.dev"
}
```

## 8. Vérifier le parcours complet

Depuis la Toolbox :

1. AntiMicroX → Profils communautaires → Actualiser : les deux exemples doivent apparaître.
2. Partager un petit profil personnel autorisé, puis confirmer l'envoi public après validation.
3. Vérifier la réponse `pending`. Le ZIP reste dans `exports/community/`.
4. Espace validateur : suivre l’appairage sur la page PC ci-dessus, avec la **CLE VALIDATEUR**.
5. Lire toutes les informations et les mappages. Accepter et publier.
6. Actualiser le catalogue : le nouveau profil doit apparaître.
7. Vérifier sur GitHub le commit contenant simultanément le profil et `catalog.json`.
8. Répéter avec un preset ReShade et une proposition refusée.

Fermer l'espace validateur termine la session. Une session expire après 30 minutes même
si une panne réseau empêche sa révocation immédiate. Le jeton temporaire est enregistré
avec des droits 0600 puis supprimé à la sortie ; la clé validateur n'est pas sauvegardée par la Toolbox.

Pendant ces premiers essais, consulter Worker → Metrics et les erreurs. Le plan gratuit
accorde 10 ms CPU par requête : il faut vérifier les requêtes d'envoi ET de publication sur
le véritable environnement Cloudflare. Les tests locaux ne garantissent pas cette limite.

## Dépannage

- **Hello World** : le nouveau code n'est pas encore déployé.
- **configured: false / HTTP 503** : vérifier DB et les noms exacts des secrets.
- **HTTP 401** : clé incorrecte ou session expirée ; se reconnecter.
- **HTTP 429** : trop de tentatives ; attendre la fin de la période de limitation.
- **GitHub publication failed (403)** : permissions ou expiration du jeton, ou règle de branche.
- **HTTP 409 lors d'une validation** : une publication peut être en cours ; attendre puis rouvrir.
- **Envoi non confirmé** : conserver le ZIP et utiliser « Renvoyer un paquet conservé ».
  Le même paquet garde son identifiant ; une réponse perdue ne crée pas de doublon.
- **Erreur CPU Cloudflare** : relever l'erreur et l'opération ; ne pas passer au payant automatiquement.
- Les réglages clavier ne sont pas exécutés pendant la revue ; l'inspection ne lance pas AntiMicroX.

Pour révoquer les accès validateurs, générer une nouvelle clé, remplacer `ADMIN_KEY_HASH`,
puis exécuter `DELETE FROM sessions; DELETE FROM device_sessions; DELETE FROM devices; DELETE FROM pairings;` dans la console D1. Renouveler `GITHUB_TOKEN` avant
son expiration. Ne jamais inclure de secrets dans les journaux transmis pour diagnostic.

## Diagnostic d'une erreur lors de la publication

La révision `publication-diagnostics-1` conserve le schéma D1, les secrets et les appareils
appairés. Remplacer uniquement `dist/worker.js` dans Cloudflare et redéployer. `/health`
affiche maintenant `"revision":"publication-diagnostics-1"`.

Une erreur indique une étape et une référence, par exemple :
`Publication/service failure: NETWORK_ERROR [github_ref_read; ref 1234abcd]`.
Les journaux Cloudflare contiennent seulement la référence, l'étape et une catégorie ;
ils ne journalisent ni clé, ni jeton, ni en-tête Authorization, ni contenu du profil.

- `d1_publication_claim` : réservation de la proposition dans D1.
- `publication_validate` : vérification du profil conservé dans la file.
- `github_ref_read`, `github_commit_read`, `github_catalog_read` : lectures GitHub.
- `catalog_decode` : lecture du catalogue JSON téléchargé.
- `github_tree_create`, `github_commit_create`, `github_ref_update` : publication GitHub.
- `d1_publication_finalize` : enregistrement de la réussite dans D1.

`D1_MISSING_COLUMN` ou `D1_MISSING_TABLE` demande une vérification du schéma.
`GitHub publication failed (HTTP 401/403)` demande une vérification du jeton et des permissions.
`NETWORK_ERROR` et `UPSTREAM_TIMEOUT` signalent un problème de connexion à l'étape indiquée.
Un arrêt imposé par la limite CPU de Cloudflare ne peut pas être intercepté par le code :
consulter alors le champ Outcome et les erreurs de la requête dans Observability.

Une proposition `pending` est conservée pour réessayer. Un état `publishing` peut rester
jusqu'à l'expiration du verrou de cinq minutes après une interruption brutale. Ne pas
renvoyer un nouveau profil pour contourner une erreur d'acceptation.

## Développement

Node.js 24 : `npm ci`, `npm test`, `npm run build` dans `service/`. Les tests utilisent une
base SQLite en mémoire avec adaptation de l'API D1 et une simulation GitHub ; ils ne
créent aucune proposition réelle et ne publient rien sur GitHub. `dist/worker.js` est le
bundle prêt pour le tableau de bord. Le fichier `wrangler.jsonc.example` permet aussi un
déploiement par Wrangler après remplacement de l'identifiant de base, pour un mainteneur.
