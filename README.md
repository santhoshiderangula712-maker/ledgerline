# \# LedgerLine

# 

# Money movement with a ledger you can prove.

# 

# Live: https://ledgerline-pae3.onrender.com

# 

# \## Demo accounts (fake money)

# 

# | Role | Email | Password |

# |---|---|---|

# | Admin | admin@ledgerline.test | Admin-demo-2026 |

# | Account holder | alice@ledgerline.test | Alice-demo-2026 |

# | Account holder (second) | bob@ledgerline.test | Bob-demo-2026 |

# | Auditor | auditor@ledgerline.test | Auditor-demo-2026 |

# 

# \## Run locally

# 

# 1\. `npm install`

# 2\. Create `.env` with `DATABASE\_URL=<your Postgres URL>`

# 3\. `npm run migrate` then `npm run seed`

# 4\. `npm run dev`

# 5\. `npm run attack` (checks replay, race, theft, role rules)

