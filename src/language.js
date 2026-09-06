/** RelayForge ST front end. No eval, Function constructor, or generated JavaScript. */
export class CompileError extends Error {
  constructor(message, token = {}) {
    super(message); this.name = 'CompileError'; this.line = token.line || 1; this.column = token.column || 1;
  }
}
const PRECEDENCE = { OR:1, XOR:2, AND:3, '=':4, '<>':4, '<':5, '>':5, '<=':5, '>=':5, '+':6, '-':6, '*':7, '/':7, MOD:7 };
export function parseDuration(text) {
  const body = text.replace(/^(?:TIME|T)#/i, '');
  let sum = 0, consumed = '';
  for (const match of body.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi)) {
    sum += Number(match[1]) * {d:86400000,h:3600000,m:60000,s:1000,ms:1}[match[2].toLowerCase()];
    consumed += match[0];
  }
  if (!consumed || consumed.toLowerCase() !== body.toLowerCase() || !Number.isSafeInteger(sum) || sum > 2147483647)
    throw new CompileError(`Invalid TIME literal '${text}'; expected 0..2147483647 integer milliseconds.`);
  return sum;
}
export function tokenize(source) {
  if (source.length > 500000) throw new CompileError('Source exceeds the 500 KB limit.');
  const tokens = []; let i = 0, line = 1, column = 1;
  const advance = s => { for (const c of s) { if (c === '\n') { line++; column=1; } else column++; } i += s.length; };
  while (i < source.length) {
    const rest = source.slice(i), loc = {line,column};
    if (/\s/.test(rest[0])) { advance(rest[0]); continue; }
    if (rest.startsWith('//')) { const s = rest.split('\n')[0]; advance(s); continue; }
    if (rest.startsWith('(*')) {
      let depth=1, end=i+2;
      while (end < source.length && depth) {
        if(source.slice(end,end+2)==='(*'){depth++;end+=2;}
        else if(source.slice(end,end+2)==='*)'){depth--;end+=2;} else end++;
      }
      if(depth) throw new CompileError('Unterminated block comment.',loc);
      advance(source.slice(i,end)); continue;
    }
    let m;
    if ((m = /^(?:TIME|T)#[0-9a-z.]+/i.exec(rest))) {
      tokens.push({kind:'time',value:parseDuration(m[0]),raw:m[0],...loc}); advance(m[0]); continue;
    }
    if ((m = /^(?:\d+\.\d*|\d+|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) {
      tokens.push({kind:'number',value:Number(m[0]),real:/[.eE]/.test(m[0]),...loc}); advance(m[0]); continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*/.exec(rest))) {
      tokens.push({kind:'id',value:m[0],upper:m[0].toUpperCase(),...loc}); advance(m[0]); continue;
    }
    if ((m = /^(?::=|=>|<=|>=|<>|[();,:+\-*/=<>])/.exec(rest))) {
      tokens.push({kind:'symbol',value:m[0],...loc}); advance(m[0]); continue;
    }
    throw new CompileError(`Unexpected character '${rest[0]}'.`,loc);
  }
  tokens.push({kind:'eof',value:'<EOF>',line,column}); return tokens;
}
export class Parser {
  constructor(source) {this.tokens=tokenize(source);this.i=0;this.serial=0;}
  peek(offset=0) {return this.tokens[this.i+offset] || this.tokens.at(-1);}
  is(value) {return (this.peek().upper || this.peek().value)===value;}
  take() {return this.tokens[this.i++];}
  accept(value) {if(this.is(value)){return this.take();} return null;}
  expect(value) {if(!this.is(value))throw new CompileError(`Expected '${value}', found '${this.peek().value}'.`,this.peek());return this.take();}
  identifier() {const t=this.take();if(t.kind!=='id')throw new CompileError('Expected an identifier.',t);return t;}
  expression(min=0) {
    const t=this.take(); let left;
    if(t.kind==='number') left={kind:'literal',value:t.value,type:t.real?'REAL':'DINT',loc:t};
    else if(t.kind==='time') left={kind:'literal',value:t.value,type:'TIME',loc:t};
    else if(t.upper==='TRUE'||t.upper==='FALSE') left={kind:'literal',value:t.upper==='TRUE',type:'BOOL',loc:t};
    else if(t.value==='('){left=this.expression();this.expect(')');}
    else if(t.value==='-'||t.value==='+'||t.upper==='NOT') left={kind:'unary',operator:t.upper||t.value,arg:this.expression(8),loc:t};
    else if(t.kind==='id') {
      if(this.accept('(')) {
        const args=[];if(!this.is(')')){do{args.push(this.expression());}while(this.accept(','));}this.expect(')');
        left={kind:'function',name:t.upper,args,loc:t};
      } else left={kind:'reference',name:t.value,loc:t};
    } else throw new CompileError(`Expected an expression, found '${t.value}'.`,t);
    while(true){
      const op=this.peek().upper||this.peek().value, precedence=PRECEDENCE[op];
      if(precedence===undefined||precedence<min)break;
      this.take();left={kind:'binary',operator:op,left,right:this.expression(precedence+1),loc:this.peek(-1)};
    }
    return left;
  }
  sequence(until) {const body=[];while(this.peek().kind!=='eof'&&!until.some(s=>this.is(s)))body.push(this.statement());return body;}
  statement() {
    const start=this.peek(),id=`st-${this.serial++}`;
    if(this.accept(';'))return {kind:'noop',id,loc:start};
    if(this.accept('IF')){
      const arms=[];let condition=this.expression();this.expect('THEN');
      arms.push({condition,body:this.sequence(['ELSIF','ELSE','END_IF'])});
      while(this.accept('ELSIF')){condition=this.expression();this.expect('THEN');arms.push({condition,body:this.sequence(['ELSIF','ELSE','END_IF'])});}
      const otherwise=this.accept('ELSE')?this.sequence(['END_IF']):[];this.expect('END_IF');this.expect(';');
      return {kind:'if',arms,otherwise,id,loc:start};
    }
    if(this.accept('FOR')){
      const target=this.identifier().value;this.expect(':=');const from=this.expression();this.expect('TO');const to=this.expression();
      const by=this.accept('BY')?this.expression():{kind:'literal',value:1,type:'DINT',loc:start};
      this.expect('DO');const body=this.sequence(['END_FOR']);this.expect('END_FOR');this.expect(';');
      return {kind:'for',target,from,to,by,body,id,loc:start};
    }
    const name=this.identifier().value;
    if(this.accept(':=')){const value=this.expression();this.expect(';');return {kind:'assign',target:name,value,id,loc:start};}
    if(this.accept('(')){
      const inputs={},outputs={};
      if(!this.is(')'))do{
        const pin=this.identifier().value.toUpperCase();
        if(Object.hasOwn(inputs,pin)||Object.hasOwn(outputs,pin))throw new CompileError(`Duplicate argument '${pin}'.`,this.peek());
        if(this.accept(':='))inputs[pin]=this.expression();
        else{this.expect('=>');outputs[pin]=this.identifier().value;}
      }while(this.accept(','));
      this.expect(')');this.expect(';');return {kind:'invoke',name,inputs,outputs,id,loc:start};
    }
    throw new CompileError(`Expected assignment or function-block invocation after '${name}'.`,start);
  }
  program(){
    const declarations=[];
    while(this.accept('VAR')){
      while(!this.is('END_VAR')){
        const names=[this.identifier()];while(this.accept(','))names.push(this.identifier());this.expect(':');const type=this.identifier().value.toUpperCase();
        const initial=this.accept(':=')?this.expression():null;this.expect(';');
        for(const name of names)declarations.push({name:name.value,type,initial,loc:name});
      }
      this.expect('END_VAR');this.accept(';');
    }
    const body=this.sequence([]);this.expect('<EOF>');return {declarations,body};
  }
}
export function parseExpression(source) {const p=new Parser(String(source));const expr=p.expression();p.expect('<EOF>');return expr;}
export function parseST(source) {return new Parser(source).program();}
