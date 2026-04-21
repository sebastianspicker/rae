---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: evidence-index.md
---

# Bibliography

This page is the canonical documentation bibliography and cite-key registry for
RAE.

## Citation workflow

- `docs/reference/claims/bibliography.md` is the canonical source of truth for
  page-level external cite keys.
- `CITATION.cff` is the machine-readable citation surface for the repository as
  a whole.
- Every new external source should be added here before it is cited elsewhere.
- Cite keys use explicit `src-*` anchors so links remain stable even if display
  titles change.
- Pages should cite bibliography anchors rather than raw external URLs so source
  maintenance remains centralized.

## Foundational methods and governance sources

### SRC-DIATAXIS { #src-diataxis }

Diátaxis. "Diátaxis." Accessed April 17, 2026.
https://diataxis.fr/

### SRC-NIST-GENAI-PROFILE { #src-nist-genai-profile }

NIST. "Artificial Intelligence Risk Management Framework: Generative Artificial
Intelligence Profile." July 26, 2024.
https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence

### SRC-IEEE-1012 { #src-ieee-1012 }

IEEE. "IEEE Standard for System, Software, and Hardware Verification and
Validation." IEEE Std 1012-2016.
https://standards.ieee.org/ieee/1012/7344/

### SRC-MODEL-CARDS { #src-model-cards }

Mitchell et al. "Model Cards for Model Reporting." 2019.
https://arxiv.org/abs/1810.03993

### SRC-DATASHEETS { #src-datasheets }

Gebru et al. "Datasheets for Datasets." 2018.
https://arxiv.org/abs/1803.09010

### SRC-PINEAU-REPRODUCIBILITY { #src-pineau-reproducibility }

Pineau et al. "Improving Reproducibility in Machine Learning Research: A Report
from the NeurIPS 2019 Reproducibility Program." 2021.
https://openreview.net/forum?id=tIeHLnjs5Km

### SRC-NOSEK-OPEN-RESEARCH { #src-nosek-open-research }

Nosek et al. "Promoting an Open Research Culture." 2015.
https://doi.org/10.1126/science.aab2374

### SRC-SMALDINO-BAD-SCIENCE { #src-smaldino-bad-science }

Smaldino and McElreath. "The Natural Selection of Bad Science." 2016.
https://doi.org/10.1098/rspb.2015.2597

## Agent evaluation and benchmark sources

### SRC-ANTHROPIC-EFFECTIVE-AGENTS { #src-anthropic-effective-agents }

Anthropic. "Building effective agents." December 19, 2024.
https://www.anthropic.com/engineering/building-effective-agents

### SRC-OPENAI-EVALS { #src-openai-evals }

OpenAI. "How evals drive the next chapter in AI for businesses." November 19,
2025.
https://openai.com/index/evals-drive-next-chapter-of-ai/

### SRC-OPENAI-SWEBENCH-VERIFIED { #src-openai-swebench-verified }

OpenAI. "Why SWE-bench Verified no longer measures frontier coding
capabilities." February 23, 2026.
https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/

### SRC-OPENAI-PAPERBENCH { #src-openai-paperbench }

OpenAI. "PaperBench: Evaluating AI's Ability to Replicate AI Research." April
2, 2025.
https://openai.com/index/paperbench/

### SRC-G-EVAL { #src-g-eval }

Liu et al. "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment."
2023.
https://arxiv.org/abs/2303.16634

### SRC-COHEN-KAPPA { #src-cohen-kappa }

Cohen. "A Coefficient of Agreement for Nominal Scales." 1960.
https://doi.org/10.1177/001316446002000104

### SRC-ARTSTEIN-POESIO { #src-artstein-poesio }

Artstein and Poesio. "Inter-Coder Agreement for Computational Linguistics."
2008.
https://doi.org/10.1162/coli.07-034-R2

## Information, context, and model behavior sources

### SRC-SHANNON-1948 { #src-shannon-1948 }

Shannon. "A Mathematical Theory of Communication." 1948.
https://doi.org/10.1002/j.1538-7305.1948.tb01338.x

### SRC-COVER-THOMAS { #src-cover-thomas }

Cover and Thomas. "Elements of Information Theory." 2nd edition, 2006.
https://onlinelibrary.wiley.com/doi/book/10.1002/047174882X

### SRC-TRANSFORMER { #src-transformer }

Vaswani et al. "Attention Is All You Need." 2017.
https://arxiv.org/abs/1706.03762

### SRC-GPT3 { #src-gpt3 }

Brown et al. "Language Models are Few-Shot Learners." 2020.
https://arxiv.org/abs/2005.14165

### SRC-KAPLAN-SCALING { #src-kaplan-scaling }

Kaplan et al. "Scaling Laws for Neural Language Models." 2020.
https://arxiv.org/abs/2001.08361

### SRC-CHINCHILLA { #src-chinchilla }

Hoffmann et al. "Training Compute-Optimal Large Language Models." 2022.
https://arxiv.org/abs/2203.15556

### SRC-LOST-IN-THE-MIDDLE { #src-lost-in-the-middle }

Liu et al. "Lost in the Middle: How Language Models Use Long Contexts." 2023.
https://arxiv.org/abs/2307.03172

### SRC-REACT { #src-react }

Yao et al. "ReAct: Synergizing Reasoning and Acting in Language Models." 2022.
https://arxiv.org/abs/2210.03629

### SRC-TOOLFORMER { #src-toolformer }

Schick et al. "Toolformer: Language Models Can Teach Themselves to Use Tools."
2023.
https://arxiv.org/abs/2302.04761

## Coordination and socio-technical systems sources

### SRC-AMDAHL-1967 { #src-amdahl-1967 }

Amdahl. "Validity of the Single Processor Approach to Achieving Large Scale
Computing Capabilities." 1967.
https://doi.org/10.1145/1465482.1465560

### SRC-CONWAY-1968 { #src-conway-1968 }

Conway. "How Do Committees Invent?" 1968.
https://doi.org/10.1147/sj.74.0028

### SRC-BROOKS-NO-SILVER-BULLET { #src-brooks-no-silver-bullet }

Brooks. "No Silver Bullet: Essence and Accidents of Software Engineering."
1987.
https://doi.org/10.1109/MC.1987.1663532

### SRC-OLSON-OLSON { #src-olson-olson }

Olson and Olson. "Distance Matters." 2000.
https://doi.org/10.1145/333334.333343

### SRC-HERBSLEB-MOCKUS { #src-herbsleb-mockus }

Herbsleb and Mockus. "An Empirical Study of Speed and Communication in
Globally Distributed Software Development." 2003.
https://doi.org/10.1109/TSE.2003.1205177

### SRC-CATALDO-CONGRUENCE { #src-cataldo-congruence }

Cataldo et al. "Software Dependencies, Work Dependencies, and Their Impact on
Failures." 2008.
https://doi.org/10.1145/1414004.1414008

## Automation and human factors sources

### SRC-BAINBRIDGE-AUTOMATION { #src-bainbridge-automation }

Bainbridge. "Ironies of Automation." 1983.
https://doi.org/10.1016/0005-1098(83)90046-8

### SRC-PARASURAMAN-RILEY { #src-parasuraman-riley }

Parasuraman and Riley. "Humans and Automation: Use, Misuse, Disuse, Abuse."
1997.
https://doi.org/10.1207/s15327051hci1202_4

### SRC-ENDSLEY-SITUATION-AWARENESS { #src-endsley-situation-awareness }

Endsley. "Toward a Theory of Situation Awareness in Dynamic Systems." 1995.
https://doi.org/10.1518/001872095779049543

### SRC-KAHNEMAN-FAST-SLOW { #src-kahneman-fast-slow }

Kahneman. "Thinking, Fast and Slow." 2011.
https://us.macmillan.com/books/9780374533557/thinkingfastandslow

## Coverage note

The bibliography is also a thesis-support surface for the documentation corpus.
These entries are the foundational set reused across the companion volume:

- [Diataxis](bibliography.md#src-diataxis)
- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [IEEE 1012](bibliography.md#src-ieee-1012)
- [Shannon 1948](bibliography.md#src-shannon-1948)
- [Conway 1968](bibliography.md#src-conway-1968)
- [Model Cards](bibliography.md#src-model-cards)
- [OpenAI evals guidance](bibliography.md#src-openai-evals)
