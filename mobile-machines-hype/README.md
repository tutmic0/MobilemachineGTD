# Mobile Machines — "Spin for a GTD spot" hype site

Pravi, samostalni sajt (čist HTML/CSS/JS, bez build koraka). Umesto
obične forme, ljudi zarađuju **spinove** radeći follow/like/repost/
comment (po 1 spin za svaku od te 4 akcije), plus dodatne spinove kroz
**redeem kod** koji menjaš sa svakim novim postom. Telefon na ekranu
ima kolo — dugme na telefonu ga pokreće, a **ishod (pobeda/gubitak)
odlučuje isključivo server** (Google Apps Script), nikad browser — tako
niko ne može da izmeni JS kod i uvek "pobedi".

```
mobile-machines-hype/
├── index.html                    stranica
├── css/style.css                 dizajn (isti tokeni/boje kao mint sajt)
├── js/main.js                    crtanje kola, animacija, CONFIG (X handle/link)
├── img/                          4 rendera telefona iz kolekcije (hero)
├── google-apps-script/Code.gs    backend: pravila igre, verovatnoće, GTD lista
└── README.md                     ovo uputstvo
```

## 1. Otvori projekat

Isto kao i mint sajt — običan HTML/CSS/JS, može odmah preko VS Code
"Live Server" ekstenzije da se vidi izgled lokalno (forma/kolo neće
raditi dok ne povežeš Google Sheet iz koraka 2).

## 2. Poveži sajt sa Google Sheet-om (skladište + pravila igre)

1. Napravi novi Google Sheet (sheets.new).
2. `Extensions` → `Apps Script`.
3. Obriši sadržaj koji stoji tamo i zalijepi ceo sadržaj fajla
   `google-apps-script/Code.gs` iz ovog projekta.
4. `Save` (disketa ikona), pa `Deploy` → `New deployment`.
5. Klikni na zupčanik pored "Select type" → `Web app`.
6. Podesi:
   - **Execute as:** Me
   - **Who has access:** Anyone
7. `Deploy`. Google će tražiti da autorizuješ skriptu (to je tvoj
   vlastiti sheet, dozvoli).
8. Kopiraj URL koji dobiješ (izgleda kao
   `https://script.google.com/macros/s/AKfycb.../exec`).
9. Otvori `js/main.js` u ovom projektu i zalijepi taj URL u:
   ```js
   GOOGLE_SCRIPT_URL: "OVDJE_TVOJ_URL",
   ```
10. Sačuvaj. Sheet dobija kolone automatski pri prvoj prijavi:
    **Address, Handle, ActionSpins, CodeSpins, SpinsUsed, HasWon,
    RedeemedCodes, Timestamp** (Address je namerno prva kolona, vidi
    napomenu u koraku 7 ispod).

**Napomena:** ovo je backend koji nisam mogao uživo testirati odavde
(nemam pristup tvom Google nalogu) — kod prati proveren obrazac (isti
tip backend-a kao Bullshido sajt), ali svakako uradi par probnih
spinova čim ga povežeš, pre nego pustiš link javno.

## 2b. Poveži pravi "Connect X" login (X Developer Portal)

Umjesto da ljudi sami upisuju svoj X handle, sajt ih šalje na pravi X
login — kad se vrate, sigurni smo da handle stvarno pripada nalogu koji
se ulogovao. **Ovo više nije besplatno kao ranije** — X je krajem 2025.
ugasio pravi besplatni nivo za nove developer naloge; čak i samo
čitanje sopstvenog handle-a (`GET /2/users/me`) sada ide kroz
"pay-per-use" (procjena ~$0.001 po prijavi, dakle par dolara na hiljade
prijava — ali traži platnu karticu/kredit na X nalogu). Provjeri tačne
brojke na [developer.x.com](https://developer.x.com) prije nego kreneš,
pošto se cjenovnik mijenja.

Koraci:

1. Idi na [developer.x.com](https://developer.x.com), napravi projekat
   i app (besplatna prijava/registracija app-a, plaća se tek pravi
   poziv).
2. U app podešavanjima → `User authentication settings` → uključi
   **OAuth 2.0**, tip app-a **"Web App, Automated App or Bot"** (ovo je
   bitno — to je tip koji dobija i Client Secret, tako da tajni ključ
   ostaje samo na serveru/Apps Script-u, nikad u browseru).
3. Permissions: dovoljno je **Read**.
4. **Callback URI / Redirect URL**: ovdje ide TAČNO onaj isti Web App
   URL koji si dobio u koraku 2.8 (`.../exec`). X zahtijeva potpuno
   poklapanje, pa prvo deployuj Code.gs (korak 2), zalijepi taj URL
   ovdje na X-u, pa nastavi na korak 5.
5. Nakon čuvanja, X ti daje **Client ID** i **Client Secret**.
6. U `google-apps-script/Code.gs`, na vrhu fajla, zalijepi:
   ```js
   var X_CLIENT_ID = "...";          // Client ID (nije tajna)
   var X_REDIRECT_URI = "...";       // isti .../exec URL kao gore
   var SITE_URL = "...";             // link ka ovom sajtu (korak 5 dolje)
   ```
7. Client Secret **NIKAD** ne ide u ovaj fajl niti u chat. U Apps
   Script editoru: zupčanik "Project Settings" (lijevi meni) → **Script
   Properties** → `Add script property` → ime `X_CLIENT_SECRET`,
   vrijednost = tvoj Client Secret → Save.
8. `Deploy` → `Manage deployments` → uredi postojeći deployment (da
   promjene u Code.gs stupe na snagu na ISTOM URL-u — bitno je da URL
   ostane isti jer si ga već zalijepio na X-u kao redirect URI).
9. Testiraj: otvori sajt, klikni "Connect X", uloguj se — trebao bi te
   vratiti na sajt kao "Connected as @tvojhandle".

`SESSION_SECRET` (kojim se potpisuje sesija nakon logina) se generiše
sam od sebe pri prvom korištenju — ne moraš ništa raditi oko toga.

## 3. Pravila igre — sve je u `google-apps-script/Code.gs`

Na vrhu fajla:

```js
var MAX_WINNERS = 150;          // koliko GTD mesta ukupno ide kroz OVU kampanju
var WIN_PROBABILITY = 0.05;     // 5% šanse po spinu da pogodiš GTD (dok ima mesta)
var BONUS_PROBABILITY = 0.12;   // 12% šanse po spinu da dobiješ +1 spin (besplatno)
var CURRENT_CODE = "SIGNAL01";  // menjaj ovo sa SVAKIM novim postom
var SPINS_PER_CODE = 2;         // koliko spinova nosi taj kod
var ENROLLMENT_CLOSED = false;
```

**Bitno o `MAX_WINNERS`**: ovo je namerno *odvojeno* od ugovorom
definisanog `GTD_SUPPLY` (1,000 ukupno) — ti si tražio da ovo bude
"teško, ali moguće", pa je podrazumevano postavljeno na 150 (manje od
ukupnih 1,000 GTD mesta). Odluči pravi broj pre nego pustiš link javno
i promeni ga ovde. Kad se `MAX_WINNERS` popuni, kolo prestaje da daje
"GTD WON" ishod zauvek (i dalje može da padne na "+1 spin" ili "bez
sreće") — ovo se proverava na serveru svaki put, ne samo jednom.

Kad okačiš novi post (novi teaser, novi update), promeni `CURRENT_CODE`
na nešto novo, deploy ponovo (`Deploy` → `Manage deployments` → uredi
postojeći deployment), i objavi taj kod u samom postu ili replyu. Stari
kod prestaje da važi čim promeniš `CURRENT_CODE` — svako ko ga je već
iskoristio ostaje da mu spinovi koje je zaradio, samo taj tačan string
više ne prolazi validaciju.

`WIN_PROBABILITY`/`BONUS_PROBABILITY` menjaj po osećaju — nižа šansa
znači da će trebati više ljudi/spinova da se popuni `MAX_WINNERS`, viša
šansa znači brže punjenje ali i manje "ekskluzivan" osećaj.

## 4. Pre nego pustiš link, popuni `js/main.js`

```js
var CONFIG = {
  GOOGLE_SCRIPT_URL: "...",           // iz koraka 2
  xHandle: "MobileMachines",          // tvoj X handle, bez @
  xPostUrl: "https://x.com/.../status/...", // link ka najavnom postu (video)
  enrollmentClosed: false,
};
```

`xPostUrl` MORA biti pravi link ka konkretnom postu koji si okačio —
to je post koji ljudi treba da lajkuju/repostuju/komentarišu.

**Napomena o identitetu:** handle se više ne upisuje ručno — dolazi
isključivo iz pravog "Connect X" logina (korak 2b). Follow/like/
repost/comment dugmad i dalje NE prolaze kroz X API (to bi značilo
plaćati po provjeri) — klik otvori pravi X link u novom tabu, i kad se
korisnik vrati na sajt nakon bar 5 sekundi, akcija se sama otkvači.
Ovo je namjerno "na povjerenje" (isto kao i ranije sa checkboxovima) —
identitet je sad stvaran, akcije ostaju na časnu riječ, uz ručni
pregled liste prije finalizacije GTD-a (korak 7 dolje).

## 5. Postavi na Vercel

Isto kao i za mint sajt:

1. Napravi GitHub repo, ubaci ceo ovaj folder (`git init`, `git add .`,
   `git commit`, `git push`).
2. vercel.com → `Add New` → `Project` → izaberi repo → `Deploy` (čist
   statički sajt, ne treba build komanda).
3. Dobijaš radni link (`neki-naziv.vercel.app`) za par sekundi.

Ili bez GitHub-a: `npm i -g vercel`, pa `vercel` u folderu projekta.

## 6. Kad zatvoriš kampanju

1. `js/main.js`: `enrollmentClosed: true`.
2. `google-apps-script/Code.gs`: `ENROLLMENT_CLOSED = true`, pa ponovo
   `Deploy` → `Manage deployments` → uredi postojeći deployment.
3. `git push` (ili ponovo `vercel`).

## 7. Kako pobednici sa kola postaju stvarna GTD Merkle lista

**Bitna razlika od proste forme**: u Google Sheet-u su svi koji su ikad
registrovali handle/adresu (uključujući one koji nikad nisu pogodili),
ne samo pobednici. Pre nego što praviš pravu GTD listu:

1. Otvori Google Sheet, filtriraj samo redove gde je **HasWon = TRUE**
   (`Data` → `Create a filter`, pa filter na koloni F).
2. Sa filtriranim prikazom: `File` → `Download` → `.csv` — dobijaš CSV
   koji sadrži samo stvarne pobednike, sa Address kao prvom kolonom
   (baš format koji `mobile-machines/scripts/build-gtd-tree.js
   <roster.csv>` očekuje — čita prvo polje svakog reda, header se
   automatski prepoznaje i preskače).
3. Pokreni `node scripts/build-gtd-tree.js <preuzeti.csv>` iz
   `mobile-machines/` foldera — dobijaš `build/gtd-root.txt` (za
   `machines.setMerkleRoot(...)`) i `build/gtd-proofs.json` (mint sajt
   ga koristi da nađe `proof` za povezani novčanik).
4. Pre nego što to postane finalna lista, ručno uporedi red po red sa
   stvarnim lajkovima/repostovima/komentarima na X postu — sajt
   proverava format handle-a/adrese, ali ne i da su te tvrdnje stvarno
   tačne, niti da isti čovek nije napravio 5 različitih novčanika da
   dobije više pokušaja. Za nagradu ovog tipa (GTD mesto, ne direktan
   novac) to je prihvatljiv rizik, ali svakako pregledaj listu pre
   finalizacije.

## Zašto ovako, a ne samo forma

Sa 0 pratilaca, X algoritam praktično ne pokazuje post nikome van tvoje
mreže dok ne dobije ranu interakciju. Obična forma ("uradi 4 stvari pa
popuni formu") radi, ali kolo sreće dodaje pravu igru — ljudi vole
mehaniku "možda baš ja pogodim", vraćaju se po još pokušaja (redeem
kod), i pričaju o tome drugima ("skoro sam pogodio, probaj i ti") —
sve to je dodatni razlog za deljenje van same nagrade.
