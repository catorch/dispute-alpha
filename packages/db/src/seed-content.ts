/** Default letter template seeded for new organizations. Org Admins edit it in the template editor. */
export const DEFAULT_TEMPLATE_HTML = `<p>{{sender.name}}<br>{{sender.address_block}}</p>
<p>{{date}}</p>
<p>{{target.name}}</p>
<p>Re: Request for investigation of inaccurate information</p>
<p>Consumer: {{client.full_name}}<br>{{client.address_block}}<br>Date of birth: {{client.dob}}<br>SSN (last 4): {{client.ssn_last4}}</p>
<p>I am writing to dispute the following information in my file. The items listed below are inaccurate or incomplete. Under the Fair Credit Reporting Act, please investigate and correct or delete them.</p>
<ul>{{#each items}}<li><strong>{{item.furnisher}}</strong>, account {{item.account_mask}}: {{item.reason}}</li>{{/each}}</ul>
<p>Enclosed are copies of my identification and proof of address. Please send me written results of your investigation.</p>
<p>Sincerely,<br>{{client.full_name}}</p>`;
