# The AI package and the MCP Connector: record of processing and consent copy

The paid AI package and the MCP Connector are listed under "Paid modules" in
[ROADMAP.md](../ROADMAP.md) and built only on the public plugin API
([gap audit](ai-package-gap-audit.md)). The AI package sends text from the
association to a language model provider, and that is the one question the
instance cannot settle for itself: who is the provider to the association?
This page answers it, and gives the wording of the declaration and of the
consent screen that follow from the answer. The connector sends nothing of its
own, and its answer is short ([The connector](#the-connector)).

The AI package's author copies the declaration into the manifest and the
wording into the catalog entry. A change to what the plugin does changes this
page in the same pull request. A declaration narrower than what the plugin does
makes the association's record, and the consent its board gave, wrong
([plugin contract](plugin-contract.md#where-the-plugin-sends-personal-data)).

> **Not legal advice.** The maintainers wrote this to fix what the AI package
> may do before it is built. The points in [Open points](#open-points) need an
> answer before the package is listed in the catalog.

## What the AI package processes

| What                                                       | About whom                          | Where it goes or is kept                                                               |
| ---------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| What a board member types to the assistant                 | Whoever the text names              | To the model provider; not kept by the plugin                                          |
| Text the assistant reads through an action offered on `ai` | The people the text names or was by | To the model provider; not kept by the plugin                                          |
| A change the assistant proposes                            | The person it was proposed as       | A pending change: expires after seven days, deleted the night after (ADR 0039)         |
| The provider key                                           | Nobody                              | A secret setting, encrypted at rest (ADR 0037)                                         |
| A request to the provider that carries personal data       | The people it names, by id          | Audit log, on each one's access report (`host.recipients.fetch`)                       |
| A change the assistant's proposal leads to once confirmed  | As the action records it            | The audit log, on the channel `web`, linked to the proposal, which is recorded on `ai` |

What the assistant can read is decided by the core and not by the plugin. It
reaches the actions offered on the `ai` surface and the plugin's own actions an
administrator has armed, as the person who asked, with what that person may do
at that moment. An action that declares protected personal data is never
offered on `ai`, so what such an action returns does not reach the model
([actions](actions.md#what-no-action-may-do)). `host.recipients.fetch` refuses a
request that names a person with protected personal data or under a restriction
of processing as a subject, before anything is sent.

That is a limit on what the host can check, not a guarantee that no such person
is ever named to the provider. The text of a document is returned as it is
stored: it is not scanned or redacted, and it may name a protected person.
`host.recipients.fetch` checks only the subject ids the plugin supplies, and it
does not read the body. Whoever may read a document may therefore have the
assistant read it, and a protected person named in its text goes to the
provider with the rest ([ADR 0041](adr/0041-read-actions-for-documents-and-meetings.md)).

Text that residents wrote - an issue report, a message on the contact form,
the text of a document - is free text and may name anybody and say anything,
health included. The categories declared below are the ones the assistant's
actions declare (`name` and `freeText` for the documents), so a category an
action adds is added here in the same change.

## Who is who: the processor question

The consent step asks the board where the plugin sends personal data, and the
AI package's answer is **yes, to the model provider**. A declared recipient
fills in the question and the board classifies it. A plugin's declaration cannot
say whether a party acts on the association's instructions, so nothing installs
until the board has ([plugin contract](plugin-contract.md#where-the-plugin-sends-personal-data)).

The recommended set-up for the first release, and the one this page is written
for, is that **the association brings its own provider key**.

| Party                      | Role                  | Why                                                                                                                                                                                         |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The association            | Controller            | It decides that the text is sent and for what: the board member's request, in the association's own administration.                                                                         |
| The model provider         | Processor             | It processes the text on the association's behalf and under its instructions, on the terms of the association's own account. Art. 28(3) needs a written agreement between the two.          |
| Apteo                      | Not a recipient       | The plugin runs inside the instance and calls the provider from there. Nothing passes through a service of Apteo's. A licence presentation carries no personal data (ADR 0042).             |
| Whoever hosts the instance | Processor, as already | It carries the instance as before. It does not receive the request to the provider as a party to it, and the provider is not its sub-processor, since the association engaged the provider. |

What the board has to do, and what the data protection screen then records:

1. **Classify the recipient as a processor.** The step starts with "yes" chosen
   and the host of the provider in the recipient field. It does not choose the
   classification.
2. **Accept the provider's data processing terms** on the association's account
   with it. The agreement is the provider's standard addendum or one the
   association negotiates. The board records which on the processor agreement.
3. **Record the location and the safeguards.** A provider outside the EU/EEA
   needs a transfer mechanism (art. 44 ff.), and the board records which on the
   same record.
4. **Check the account's settings.** Whether the provider keeps what it
   receives, for how long, and whether it trains on it are settings of the
   account and of the agreement, not of the plugin. The consent copy tells the
   board to look.

The alternative is that Apteo hosts the model access. Apteo would then be the
association's processor for this text, and would need a processor agreement
with the association, a sub-processor agreement with the provider, billing and
a provider in the EU. Nothing here prepares for that, and the provider is an
interface in the plugin so that it can come later. See [Open points](#open-points).

### The connector

The connector sends nothing to a provider. A member connects an app of their
own, and the app is the member's tool, not a processor the association engaged
([ADR 0009](adr/0009-mcp-sign-in.md#an-mcp-client-is-not-a-processor)). Each
registered and consented app is already listed in the record of processing as an
independent controller. What the app does with what it reads is the member's
choice and the app vendor's terms, and the association's notice to members says
so (Open point 4).

## The entry in the record of processing activities

This is what the board reads on the data protection screen after installing, in
the association's language. The board's own edits there keep winning over it.

| Field                  | Swedish                                                                                                                                                                                                                                                                                                                         | English                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | AI-paketet                                                                                                                                                                                                                                                                                                                      | The AI package                                                                                                                                                                                                                                                                                                                      |
| Purpose                | Hjälpa en styrelseledamot att sammanfatta, besvara och utarbeta föreningens egna texter med en språkmodell: ärenden, meddelanden, handlingar och ändringar av webbplatsen. En ändring görs först när styrelseledamoten har bekräftat den.                                                                                       | Help a board member summarise, answer and draft the association's own texts with a language model: issues, messages, documents and changes to the website. A change is made only after the board member has confirmed it.                                                                                                           |
| Legal basis            | Berättigat intresse (art. 6.1 f): föreningens intresse av att sköta sin förvaltning effektivt.                                                                                                                                                                                                                                  | Legitimate interest (art. 6(1)(f)): the association's interest in running its administration efficiently.                                                                                                                                                                                                                           |
| Data subjects          | Medlemmar och boende.                                                                                                                                                                                                                                                                                                           | Members and residents.                                                                                                                                                                                                                                                                                                              |
| Personal data          | Namn och fri text. Fri text kan nämna vem som helst.                                                                                                                                                                                                                                                                            | Name and free text. Free text may name anybody.                                                                                                                                                                                                                                                                                     |
| Retention              | AI-paketet sparar inte det som skrivits eller svarats. En föreslagen ändring förfaller efter sju dagar och dess innehåll raderas vid nästa nattliga rensning. Ett rättsligt bevarandekrav eller en begränsning av behandling skjuter upp raderingen tills det hävs. Leverantörens lagring bestäms av föreningens avtal med den. | The AI package keeps neither what was typed nor what was answered. A proposed change expires after seven days and its input is deleted by the following nightly purge. A legal hold or a restriction of processing postpones the deletion until it is lifted. The provider's storage is set by the association's agreement with it. |
| Recipients             | Språkmodellens leverantör, som tar emot texten för att besvara den. Den står i föreningens förteckning över mottagare som personuppgiftsbiträde.                                                                                                                                                                                | The language model provider, which receives the text in order to answer it. It is in the association's list of recipients as a processor.                                                                                                                                                                                           |
| Third-country transfer | Beror på leverantörens plats. Föreningen antecknar var leverantören behandlar texten och vilken skyddsåtgärd som gäller.                                                                                                                                                                                                        | Depends on where the provider is. The association records where the provider processes the text and which safeguard applies.                                                                                                                                                                                                        |

The row on legal basis is a proposal for a lawyer ([Open point 1](#open-points)).
Under legitimate interest a person may object (art. 21). ADR 0035 describes how
the board's granted objection keeps a person out of what a plugin reads from the
register. That is not built yet, so the plugin cannot rely on it today
([Open point 6](#open-points)).

## The declaration for the manifest

```jsonc
{
  "openbrf": {
    "id": "ai-package",
    "ai": true,
    "personalData": ["name", "freeText"],
    "recipients": [
      {
        "id": "model-provider",
        "origin": "https://api.anthropic.com",
        "purpose": {
          "sv": "Skickar texten styrelseledamoten ber om hjälp med till språkmodellen och tar emot svaret.",
          "en": "Sends the text the board member asks for help with to the language model and receives the answer.",
        },
        "personalData": ["name", "freeText"],
      },
    ],
    "processing": {
      "purpose": {
        "sv": "Hjälpa en styrelseledamot att sammanfatta, besvara och utarbeta föreningens egna texter med en språkmodell: ärenden, meddelanden, handlingar och ändringar av webbplatsen. En ändring görs först när styrelseledamoten har bekräftat den.",
        "en": "Help a board member summarise, answer and draft the association's own texts with a language model: issues, messages, documents and changes to the website. A change is made only after the board member has confirmed it.",
      },
      "legalBasis": "legitimateInterest",
      "legitimateInterest": {
        "sv": "Föreningens intresse av att sköta sin förvaltning effektivt.",
        "en": "The association's interest in running its administration efficiently.",
      },
      "retention": {
        "sv": "AI-paketet sparar inte det som skrivits eller svarats. En föreslagen ändring förfaller efter sju dagar och dess innehåll raderas vid nästa nattliga rensning. Ett rättsligt bevarandekrav eller en begränsning av behandling skjuter upp raderingen tills det hävs.",
        "en": "The AI package keeps neither what was typed nor what was answered. A proposed change expires after seven days and its input is deleted by the following nightly purge. A legal hold or a restriction of processing postpones the deletion until it is lifted.",
      },
      "dataSubjects": ["members", "residents"],
    },
    "settingsSchema": {
      "fields": [
        { "key": "apiKey", "type": "secret", "labelKey": "settings.apiKey" },
      ],
    },
  },
}
```

Why the declaration is what it is:

- **`ai: true`.** A language model chooses what the plugin dispatches. The audit
  log then records its proposals on the channel `ai`, and it reaches only what is
  offered to the AI package ([ADR 0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md)).
- **One recipient, one origin.** The package connects to the provider and to
  nothing else, and says so on the consent screen. A second provider, or the
  same one at another origin, is a new recipient and holds the package until
  the board consents again (`recipients-widened`).
- **The recipient receives `name` and `freeText`** and no more. Naming a
  category that is not declared there is refused in the host
  (`personal-data-not-declared`).
- **The key is a secret setting.** It is never shown again, and the audit log
  names it by key and never by value.
- **The declaration states no retention for the provider.** The plugin cannot
  know it. The consent copy points the board to the agreement.
- **`processing` is read once the host side of ADR 0035 is built** (see
  [Open points](#open-points)).

## The consent screen

Before anything is downloaded the board reads the permissions, the categories,
the recipient and what an AI package is. The host words the last part from `ai`
and the recipient from `recipients`; the plugin does not. What the board sees
from the host today is the row "An AI package" with the translation in
`packages/i18n/src/locales/en.json`: "What it changes is
recorded in the audit log as made through the AI package." That sentence is
older than the pending changes and is not exact: a proposal is recorded on `AI`
and a confirmed change on `WEB`. The table gives the host copy this page
requires instead; the translation and the panel (`ConsentPanel.tsx`) have not
been changed, and until a separate change ships it the board sees the older
sentence:

| Shown         | Required value                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| An AI package | A language model chooses what this plugin does, acting as the person who asked it.                                                   |
|               | It can do only what is offered to the AI package, and a plugin's action only once an administrator has switched it on.               |
|               | What it proposes is recorded in the audit log as made through the AI package, and a confirmed change as the person who confirmed it. |
| Recipient     | The host of the provider, what it is connected to for, and the categories it receives.                                               |
| The question  | Where does the plugin send personal data? "Yes" is chosen and the provider's host is filled in. The board classifies the recipient.  |
| Personal data | Name, free text                                                                                                                      |

The plugin's description in the catalog entry, which the consent screen shows
beside these, says what the board is agreeing to in a form a resident can be
given:

> **English.** The AI package lets a board member ask a language model to
> summarise issue reports and messages, answer from the association's documents
> and draft changes to the website. The text the board member asks about is sent
> to the model provider whose key the association enters, and the provider is a
> processor: the association needs a written agreement with it and should check
> where it processes the text and how long it keeps it. Nothing is changed until
> the board member has confirmed it. A proposal expires after seven days and is
> deleted the night after, unless a legal hold or a restriction of processing
> postpones that. Every proposal is in the audit log as made through the AI
> package, and a confirmed change as made by the board member who confirmed it,
> linked to the proposal. An action that returns protected personal data is never
> offered to the provider, but the text of a document is not scanned: it can
> name a protected person, and what it names goes to the provider with the rest.
> Text residents wrote is read as content and never followed as an instruction.
> The package keeps neither what was typed nor what was answered.

> **Svenska.** AI-paketet låter en styrelseledamot be en språkmodell sammanfatta
> felanmälningar och meddelanden, svara utifrån föreningens handlingar och
> utarbeta ändringar av webbplatsen. Texten som styrelseledamoten frågar om
> skickas till den leverantör vars nyckel föreningen anger, och leverantören är
> personuppgiftsbiträde: föreningen behöver ett skriftligt avtal med den och bör
> kontrollera var den behandlar texten och hur länge den sparar den. Inget ändras
> förrän styrelseledamoten har bekräftat det. Ett förslag förfaller efter sju
> dagar och raderas natten efter, om inte ett rättsligt bevarandekrav eller en
> begränsning av behandling skjuter upp det. Varje förslag finns i
> granskningsloggen som gjort via AI-paketet, och en bekräftad ändring som gjord
> av styrelseledamoten som bekräftade den, kopplad till förslaget. En åtgärd som
> kan returnera skyddade personuppgifter erbjuds aldrig leverantören, men texten
> i en handling genomsöks inte: den kan nämna en skyddad person, och det den
> nämner går till leverantören tillsammans med resten. Text som boende har
> skrivit läses som innehåll och följs aldrig som en instruktion. Paketet sparar
> inte det som skrivits eller svarats.

## What the plugin has to do to match

Each line is a rule the declaration relies on. A review of the plugin checks it
against the code.

1. Every request to the provider goes through `host.recipients.fetch` with a
   `disclosure` that names the categories in the body and the persons it is
   about. The plugin opens no other connection, because a declaration is not a
   fence and the catalog's review of the server bundle is what holds it to the
   declaration.
2. A person with protected personal data or under a restriction is not named as
   a subject of a request, and neither is one who has objected once the host
   reads objections (Open point 6). The plugin treats a `subject-refused` answer
   as the answer and does not retry without the subject. The host cannot see a
   person named only in the text, so the plugin does not claim more than this
   (Open point 8).
3. The plugin keeps no prompt, no answer and no model transcript. Not in
   `host.records`, not in the log, not in a job's payload. What a pending change
   holds is the host's.
4. The key is read from `host.settings.read()` and sent only in the request to
   the recipient. It is never written to the log or returned by a route.
5. Text a resident wrote is passed to the model as quoted data, marked as such.
   The tools offered are the armed actions `host.actions.list` returns, and no
   other.
6. A write is proposed with `host.actions.propose` and never invoked. Publishing
   a news item together with its news mailing is two steps, and the mailing is
   confirmed as its own.
7. The usage cap counts calls per instance and keeps no text.
8. The plugin states on its own screens that the provider is a processor and
   that the board needs an agreement with it.

## Open points

1. **The legal basis.** Legitimate interest fits an assistant that reads the
   association's own texts for the board's work, and it carries the right to
   object. A lawyer may prefer that the original basis of each text carry over
   (the issue report's, the document's), or that the assistant be limited to
   texts the board member already holds the right to read, which it already is.
   **Reasoned.** To confirm before listing.
2. **Who is who when Apteo hosts the instance.** This page treats the provider
   as the association's own processor because the association engaged it with
   its own key, and not as a sub-processor of the host. A lawyer should confirm
   that when the host is Apteo. **Reasoned.**
3. **Third-country transfer.** The first adapter is Anthropic's, whose terms,
   regions and transfer mechanism are the association's to read at signing.
   Whether a provider with EU processing is available and should be the
   default is open. **Open** for the board.
4. **The connector and the members.** The association's notice to members should
   say that a member who connects an app of their own decides what the app
   does with what it reads. Whether that sentence belongs on the connection
   screen, in the privacy notice, or both is not decided. **Open** for the
   CTO.
5. **Apteo-hosted model access.** Deferred in the plan. It would make Apteo a
   processor and needs an agreement, billing and an EU provider. **Open** for
   the board.
6. **Not yet checkable by the build.** `parsePluginPackage` does not read
   `processing` yet, and a granted objection does not yet keep a person out of
   what a plugin reads, because the host side of ADR 0035 is not built. The
   AI package's repository validates this block against the manifest schema in
   its own build when it lands.
7. **The paid clause.** ROADMAP.md says the AI package is paid under (a),
   because model inference is a running cost Apteo pays per use. With the
   association's own key Apteo pays nothing for inference. Either the package
   is paid for another reason, which would be (d) and needs a board decision to
   be added to the list of licensed modules, or the set-up above is not the
   one that ships. **Open** for the board.
8. **A protected person named in a document's text.** An action declaring
   `protected` is not offered on `ai`, and `host.recipients.fetch` refuses a
   protected or restricted subject id. The text a document action returns is
   neither scanned nor redacted, and the host checks only the ids it is given,
   so a document that names a protected person sends that name to the provider
   if a board member who may read it asks about it. The shelf rule decides who
   may read a file ([ADR 0041](adr/0041-read-actions-for-documents-and-meetings.md)).
   Whether to scan, to warn the board member or to accept it is not decided.
   **Open** for the CTO.
