const c=(id,tag,negated=false)=>({id,tag,negated});
export function createDemo(){
  const tag=(name,type,io,initial,address,comment,retain=false)=>({id:`tag-${name}`,name,type,io,initial,address,comment,retain});
  return {
    schemaVersion:1,id:'relayforge-bottling-cell',name:'Bottling_Cell',cycleMs:20,entry:'main',plantEnabled:true,
    tags:[
      tag('Start','BOOL','input',false,'%I0.0','Momentary start pushbutton'),
      tag('Stop','BOOL','input',false,'%I0.1','Stop request'),
      tag('EStopOK','BOOL','input',true,'%I0.2','Simulated interlock only — not a safety function'),
      tag('PartSensor','BOOL','input',false,'%I0.3','Rising-edge bottle detector'),
      tag('ResetBatch','BOOL','input',false,'%I0.4','Reset the batch counter'),
      tag('LevelRaw','INT','input',7741,'%IW64','Analog level: 0..27648'),
      tag('Motor','BOOL','output',false,'%Q0.0','Conveyor motor command'),
      tag('FillValve','BOOL','output',false,'%Q0.1','Tank inlet valve'),
      tag('HighLevelAlarm','BOOL','output',false,'%Q0.2','Level exceeds 95 percent'),
      tag('SpeedCommand','REAL','output',0,'%QD68','Analog speed command: 0..100 percent'),
      tag('RunRequest','BOOL','memory',false,'%M0.0','Sealed-in cycle request'),
      tag('StartReady','BOOL','memory',false,'%M0.1','Start delay has elapsed'),
      tag('BatchDone','BOOL','memory',false,'%M0.2','Batch target reached'),
      tag('StartDelay','TIME','memory',0,'%MD4','Elapsed start delay in milliseconds'),
      tag('PartsCount','DINT','memory',0,'%MD8','Bottles counted'),
      tag('BatchTarget','DINT','memory',12,'%MD12','Requested batch size',true),
      tag('TankLevel','REAL','memory',28,'%MD16','Scaled tank level: 0..100 percent'),
      tag('LevelSetpoint','REAL','memory',75,'%MD20','Fill valve level setpoint',true),
      tag('SpeedSetpoint','REAL','memory',60,'%MD24','Conveyor speed setpoint',true)
    ],
    blocks:[
      {id:'main',name:'Main',kind:'OB',number:1,language:'LAD',comment:'Cyclic program · input image → logic → output commit',networks:[
        {id:'net-latch',title:'Cycle enable · start / stop seal-in',comment:'Interlocks are evaluated before the parallel start and hold contacts.',series:[c('estop','EStopOK'),c('stop','Stop',true),c('batch-stop','BatchDone',true)],branches:[[c('start','Start')],[c('hold','RunRequest')]],action:{type:'COIL',target:'RunRequest'}},
        {id:'net-delay',title:'Conveyor start delay',comment:'Non-retentive TON. First active call starts at ET = 0 ms.',series:[c('delay-run','RunRequest')],branches:[],action:{type:'TON',inputs:{PT:'T#800ms'},outputs:{Q:'StartReady',ET:'StartDelay'}}},
        {id:'net-motor',title:'Motor output · delayed start permissive',comment:'The output process image is committed only after the whole OB completes.',series:[c('motor-run','RunRequest'),c('motor-ready','StartReady')],branches:[],action:{type:'COIL',target:'Motor'}},
        {id:'net-counter',title:'Batch production counter',comment:'CTU counts rising edges, not scans. Reset has priority.',series:[c('part-detect','PartSensor')],branches:[],action:{type:'CTU',inputs:{R:'ResetBatch',PV:'BatchTarget'},outputs:{Q:'BatchDone',CV:'PartsCount'}}},
        {id:'net-analog',title:'Analog input scaling and speed command',comment:'Call the ST function before the fill controller to use the current scaled level.',series:[],branches:[],action:{type:'CALL',block:'analog'}},
        {id:'net-fill',title:'Tank filling controller',comment:'Boolean and comparator dataflow evaluated in dependency order.',series:[],branches:[],action:{type:'CALL',block:'fill'}}
      ]},
      {id:'fill',name:'Fill_Station',kind:'FB',number:1,language:'FBD',comment:'Level-controlled inlet valve with independent high-level alarm',nodes:[
        {id:'f-level',op:'READ',tag:'TankLevel',x:60,y:90,inputs:{}},
        {id:'f-setpoint',op:'READ',tag:'LevelSetpoint',x:60,y:225,inputs:{}},
        {id:'f-compare',op:'LT',x:300,y:130,inputs:{A:{node:'f-level',port:'OUT'},B:{node:'f-setpoint',port:'OUT'}}},
        {id:'f-motor',op:'READ',tag:'Motor',x:300,y:300,inputs:{}},
        {id:'f-enable',op:'AND',x:540,y:180,inputs:{A:{node:'f-compare',port:'OUT'},B:{node:'f-motor',port:'OUT'}}},
        {id:'f-valve',op:'WRITE',tag:'FillValve',x:790,y:180,inputs:{IN:{node:'f-enable',port:'OUT'}}},
        {id:'f-alarm',op:'GT',x:540,y:390,inputs:{A:{node:'f-level',port:'OUT'},B:{expr:'95.0'}}},
        {id:'f-alarm-out',op:'WRITE',tag:'HighLevelAlarm',x:790,y:390,inputs:{IN:{node:'f-alarm',port:'OUT'}}}
      ]},
      {id:'analog',name:'Analog_Scaling',kind:'FC',number:1,language:'ST',comment:'Checked REAL arithmetic and explicit conversion from raw analog input',source:`(* Analog scaling and conveyor speed control.
   REAL operations use IEEE-754 binary32 rounding.
   Global tags are declared in the PLC tag table. *)
VAR
    Filtered : REAL := 28.0;
    RunningEdge : R_TRIG;
END_VAR

TankLevel := LIMIT(0.0,
    TO_REAL(LevelRaw) * 100.0 / 27648.0,
    100.0);

// A block-local state variable persists between scans.
Filtered := Filtered + (TankLevel - Filtered) * 0.1;
RunningEdge(CLK := Motor);

IF Motor AND EStopOK THEN
    SpeedCommand := LIMIT(0.0, SpeedSetpoint, 100.0);
ELSE
    SpeedCommand := 0.0;
END_IF;
`}
    ],
    hmi:[
      {id:'h-header',type:'label',x:32,y:24,w:820,h:38,label:'BOTTLING LINE  /  OPERATOR PANEL',tag:'',color:'#edf5fd',fontSize:20},
      {id:'h-sub',type:'label',x:32,y:64,w:810,h:24,label:'CELL 01     •     SIMULATED PROCESS     •     LOCAL RUNTIME',tag:'',color:'#8aa8c6',fontSize:11},
      {id:'h-tank',type:'tank',x:52,y:132,w:214,h:250,label:'BUFFER TANK',tag:'TankLevel',min:0,max:100,unit:'%',color:'#1cb9ca'},
      {id:'h-gauge',type:'gauge',x:310,y:132,w:228,h:174,label:'CONVEYOR SPEED',tag:'SpeedCommand',min:0,max:100,unit:'%',color:'#36a0fa'},
      {id:'h-counter',type:'value',x:590,y:132,w:248,h:104,label:'BOTTLES PRODUCED',tag:'PartsCount',unit:'bottles',color:'#d9e9fa'},
      {id:'h-motor',type:'lamp',x:590,y:256,w:118,h:83,label:'MOTOR',tag:'Motor',color:'#42d49c'},
      {id:'h-valve',type:'lamp',x:720,y:256,w:118,h:83,label:'FILL VALVE',tag:'FillValve',color:'#1cb9ca'},
      {id:'h-speed',type:'slider',x:310,y:332,w:228,h:64,label:'SPEED SETPOINT',tag:'SpeedSetpoint',min:0,max:100,step:1,unit:'%',color:'#36a0fa'},
      {id:'h-start',type:'button',x:52,y:426,w:214,h:55,label:'START CYCLE',tag:'Start',behavior:'momentary',color:'#137c62'},
      {id:'h-stop',type:'button',x:310,y:426,w:228,h:55,label:'STOP CYCLE',tag:'Stop',behavior:'momentary',color:'#ab4051'},
      {id:'h-reset',type:'button',x:590,y:426,w:248,h:55,label:'RESET BATCH',tag:'ResetBatch',behavior:'momentary',color:'#36516f'}
    ],
    watch:['Start','EStopOK','RunRequest','StartReady','Motor','FillValve','TankLevel','PartsCount','BatchDone','SpeedCommand'],
    trace:['Motor','FillValve','TankLevel','PartsCount','SpeedCommand','StartReady']
  };
}
