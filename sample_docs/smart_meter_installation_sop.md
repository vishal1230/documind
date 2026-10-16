# Smart Meter Installation — Standard Operating Procedure (Fictional sample document)

*Procedure written for a fictional utility, VoltGrid Services, to demo DocuMind. Not a real operating standard.*

## 1. Purpose and scope

This SOP describes how field teams install smart electricity meters, how each installation is tested, and how completed work is invoiced. It applies to single-phase and three-phase consumer meters.

## 2. Stages of a meter's lifecycle

Every meter moves through three tracked stages:

1. **Meter Installation (MI)** — the meter is physically installed at the consumer premises and the old meter is removed.
2. **Site Acceptance Testing (SAT)** — the installed meter is tested on site and its first readings are verified in the head-end system.
3. **Invoicing** — a meter that has passed SAT is added to the monthly invoice raised to the utility.

A meter may only be invoiced after it passes SAT. Installed meters that have not passed SAT within 15 days are flagged as "SAT pending" on the operations dashboard.

## 3. Before installation

- The field technician must carry a valid work order, an ID card and a calibrated test kit.
- The consumer must be informed at least 24 hours before the visit by SMS.
- Power to the premises may be switched off for a maximum of 30 minutes during installation.
- Technicians must wear insulated gloves and safety shoes at all times.

## 4. Installation steps

1. Photograph the old meter, clearly showing its serial number and final reading.
2. Isolate the supply and remove the old meter.
3. Install the smart meter and seal the terminal cover with a numbered seal.
4. Restore supply and confirm the meter display powers on.
5. Record the new meter's serial number, seal number and GPS location in the field app.

The old meter must be returned to the regional store within 7 days.

## 5. Site Acceptance Testing (SAT)

SAT is passed when all of the following are true:
- The meter communicates with the head-end system within 4 hours of installation.
- At least three consecutive interval readings (15-minute intervals) are received.
- The voltage reading is within ±10% of the nominal 230 V for single-phase meters.
- The tamper flag is not raised.

If SAT fails, the technician must revisit the site within 3 working days. After two failed SAT attempts, the case is escalated to the regional quality lead.

## 6. Invoicing rules

Invoices are raised on the 5th of every month and cover all meters that passed SAT in the previous calendar month. The installation rate is INR 450 per single-phase meter and INR 900 per three-phase meter. A penalty of INR 50 per meter per day applies when SAT is completed later than 15 days after installation.

## 7. Key performance indicators

The operations dashboard tracks:
- MI count versus target, per district and per week
- SAT pass rate (meters passing SAT on the first attempt divided by meters installed)
- MI-to-SAT conversion time (median days between installation and SAT)
- Invoiced versus pending amount (INR)

The target first-attempt SAT pass rate is 95%.

## 8. Data handling

Consumer phone numbers and addresses are personal data. They must only be viewed in the field app and must never be exported to spreadsheets or shared on messaging apps.
