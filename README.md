# Ultimate Wine Toolbox — Community

Profils AntiMicroX et presets ReShade partagés pour Ultimate Wine Toolbox sur Batocera.
Les deux outils gardent leurs propres menus. Le téléchargement ne nécessite aucun compte.

- `catalog.json` : contributions publiées, avec empreintes SHA-256.
- `antimicrox/` : profils SDL gamecontroller `.amgp` portables.
- `reshade/` : presets `.ini` (les effets et textures ne sont pas inclus).
- `service/` : service Cloudflare Workers + D1 de proposition et validation.
- [Installation pas à pas du service](service/INSTALLATION_FR.md).


## Proposer et valider

Avec la version de test compatible de la Toolbox : menu AntiMicroX ou ReShade →
Profils/Presets communautaires → Partager. Le profil exporté et ses métadonnées sont envoyés
à une file privée, puis rendus publics uniquement après acceptation d'un validateur.
Le pseudo est déclaré par l'auteur et ne constitue pas une identité vérifiée.

Les validateurs collent leur clé secrète sur la page PC `/pair`, puis autorisent le code
affiché sur Batocera. Une session dure 30 minutes ; la mémorisation de l'appareil pendant
30 jours est facultative et révocable depuis cette page. Ils peuvent
lire les mappages ou le preset, puis accepter ou refuser depuis le menu de chaque outil.
Une acceptation ajoute le profil et le catalogue dans un même commit GitHub.
Le menu de validation permet aussi de retirer un profil déjà publié : le fichier et
son entrée du catalogue sont retirés ensemble. Supprimer seulement le fichier sur
GitHub ne suffit pas à le retirer de la liste.

Partagez uniquement des réglages que vous êtes autorisé à publier. Ne soumettez pas de
jeux, exécutables, shaders, textures ou données personnelles. Les actions AntiMicroX
`execute` et `loadprofile`, les identifiants personnels de manette et les chemins locaux
sont refusés. Des affectations clavier restent puissantes : la revue humaine est nécessaire.

## Limites de cette première version

- Profil ou preset : 64 Kio maximum, sans fichiers joints.
- Envoi anonyme : 5 tentatives par adresse IP et par jour, 100 au total par jour.
- File privée : 200 contributions maximum ; expiration après 30 jours.
- Les limites par IP peuvent concerner plusieurs personnes derrière la même connexion.
- Connexion validateur : 10 tentatives par IP toutes les 15 minutes.
- Une nouvelle proposition crée une nouvelle entrée ; pas de remplacement automatique d'un profil publié.
- Les contrôles automatiques ne remplacent pas un essai en jeu par le validateur.
- Déploiement et vérification du temps CPU sur Cloudflare Free nécessaires avant ouverture publique.
