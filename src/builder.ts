import { Modal, Notice, Setting, type App } from "obsidian";
import { createUniqueNote } from "./bake";

export const PRESETS: Record<string,{name:string;instructions:string;yes:string;no:string}> = {
  relevant:{name:"Relevant passages",instructions:"Select passages that directly answer the question with substantive content.",yes:"The passage contributes an answer, explanation, or specific example.",no:"It only mentions the topic or is unrelated."},
  definitions:{name:"Definitions",instructions:"Select passages that define the subject or explain its boundaries.",yes:"It states what the subject means or a condition that distinguishes it.",no:"It merely mentions the subject or gives an example without explaining its meaning."},
  distinctions:{name:"Distinctions",instructions:"Select passages that explain the distinction asked about.",yes:"It directly contrasts the concepts or gives an example demonstrating the difference.",no:"It discusses only one concept without explaining the distinction."},
  practices:{name:"Concrete practices",instructions:"Select passages describing an actionable practice relevant to the question.",yes:"It describes what someone does and why or what changes as a result.",no:"It only praises an ideal or names a practice without describing it."},
  evidence:{name:"Evidence",instructions:"Select passages providing specific evidence relevant to the question.",yes:"It describes an observation, study, event, or concrete example supporting a claim.",no:"It only asserts a claim, uses a metaphor, or mentions evidence without describing it."},
};
export function queryMarkdown(question:string,preset:string,include:string,exclude:string):string {
  const p=PRESETS[preset];
  if(!p || !question.trim()) throw new Error("Enter a question and choose what to look for.");
  const line=(s:string)=>s.replace(/[\r\n]+/g," ").replace(/`/g,"'").trim();
  // Fixed templates; the builder does not generate prose or infer hidden context.
  return `# ${line(question)}\n\n\`\`\`qualitative-query\nquestion: ${line(question)}\nmode: generic\ninstructions: ${p.instructions}\ntrue: ${line(include)||p.yes}\nfalse: ${line(exclude)||p.no}\nlimit: 6\nthreshold: 0.5\nadjacent: 0\n\`\`\`\n`;
}
export class QueryBuilder extends Modal {
  constructor(app:App,private readonly folder:string){super(app);}
  onOpen():void {
    const el=this.contentEl;el.empty();el.createEl("h2",{text:"Ask your vault"});
    el.createEl("p",{text:"Find passages that answer your question. Save them in a note to connect their sources."});
    let question="",preset="relevant",include="",exclude="";
    new Setting(el).setName("Question").addTextArea(t=>t.setPlaceholder("How does solitude differ from loneliness?").onChange(v=>question=v));
    new Setting(el).setName("Look for").addDropdown(d=>{for(const [id,p] of Object.entries(PRESETS))d.addOption(id,p.name);d.onChange(v=>{preset=v;defaults.setText(`${PRESETS[v].yes} Excludes: ${PRESETS[v].no}`);});});
    const defaults=el.createEl("p",{text:`${PRESETS.relevant.yes} Excludes: ${PRESETS.relevant.no}`});
    const details=el.createEl("details");details.createEl("summary",{text:"Refine matches (optional)"});
    new Setting(details).setName("Include when").setDesc("What must a passage explain or show? Leave blank to use the default.").addTextArea(t=>t.onChange(v=>include=v));
    new Setting(details).setName("Exclude when").setDesc("What should be left out? Leave blank to use the default.").addTextArea(t=>t.onChange(v=>exclude=v));
    el.createEl("p",{text:"Saves your question and finds up to 6 passages. Results update as your notes change. With a Jev key, scoring sends passages to TypeSafe."});
    new Setting(el).addButton(b=>b.setButtonText("Save question and search").setCta().onClick(async()=>{
      b.setDisabled(true);
      try {
        const text=queryMarkdown(question,preset,include,exclude);
        const file=await createUniqueNote(this.app,this.folder,question,text);
        this.close();await this.app.workspace.getLeaf(false).openFile(file,{state:{mode:"preview"}});
      }catch(error){new Notice(error instanceof Error?error.message:String(error));b.setDisabled(false);}
    }));
  }
  onClose():void{this.contentEl.empty();}
}
