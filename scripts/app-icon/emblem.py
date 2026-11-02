"""
应用图标图案：两个交扣的折带 V 形（Λ 与 V），扁平二维，用深浅色表达折痕与上下穿插。

    python3 emblem.py <out.svg> '<json 参数>'

几何以 1024 画布为基准，参数：
  vertex_scale   尖端（Λ 顶点 / V 底尖）带宽倍数
  end_scale      外侧末端带宽倍数（< vertex_scale 即由粗到细）
  arm_scale      边长倍数，尖端不动、末端向尖端收
  close          Λ 下移、V 上移的像素数，让两者靠拢
  fit            自动居中并缩放到该外接框边长
  transparent    不画白色背景
  v_bottom_y / centerlines / barbs_on_top / zoom   调试用的几何覆盖项
"""
import sys, json, math
out=sys.argv[1]; A=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
VS=A.get('vertex_scale',1.0); ES=A.get('end_scale',1.0); ARM=A.get('arm_scale',1.0); SH=A.get('close',0)
VBY=A.get('v_bottom_y'); CL=A.get('centerlines',{}); BARB_TOP=A.get('barbs_on_top',False); ZOOM=A.get('zoom',1.0)

def sub(a,b): return (a[0]-b[0],a[1]-b[1])
def add(a,b): return (a[0]+b[0],a[1]+b[1])
def mul(a,k): return (a[0]*k,a[1]*k)
def mid(a,b): return ((a[0]+b[0])/2,(a[1]+b[1])/2)
def unit(v): L=math.hypot(*v); return (v[0]/L,v[1]/L)
def inter(p,d,q,e):
    den=d[0]*e[1]-d[1]*e[0]; t=((q[0]-p[0])*e[1]-(q[1]-p[1])*e[0])/den; return add(p,mul(d,t))

# ---- 原 nb2-1 几何（1024 画布）----
O=dict(
  b1=dict(v=[(455,256),(565,256)], e=[(220,720),(300,767)]),   # Λ 左腿（浅，压在上面）
  b2=dict(v=[(510,256),(565,256)], e=[(805,720),(725,767)]),   # Λ 右腿（深），顶端被 b1 盖住
  b3=dict(v=[(460,767),(565,767)], e=[(288,256),(220,310)]),   # V 左臂（深），底端被 b4 盖住
  b4=dict(v=[(460,767),(565,767)], e=[(802,310),(735,256)]),   # V 右臂（中，压在上面）
)
# b2 的宽度/方向取自原外沿：外沿 (565,256)->(805,720)，内沿 (510,355)->(725,767)
EDGES=dict(b1=((220,720),(455,256),(300,767),(565,256)), b2=((565,256),(805,720),(510,355),(725,767)),
           b3=((220,310),(460,767),(288,256),(510,670)), b4=((565,767),(802,310),(460,767),(735,256)))
def band_frame(k):
    a1,a2,c1,c2=EDGES[k]; d=unit(sub(a2,a1))
    # 统一方向：从末端指向尖端
    if (mid(*O[k]['v'])[0]-mid(*O[k]['e'])[0])*d[0]+(mid(*O[k]['v'])[1]-mid(*O[k]['e'])[1])*d[1]<0: d=(-d[0],-d[1])
    n=(-d[1],d[0]); w=abs((c1[0]-a1[0])*n[0]+(c1[1]-a1[1])*n[1])
    return d,n,w
BARBS=dict(TL=('b3',(288,256),[(380,345),(330,345)]), TR=('b4',(735,256),[(642,345),(690,345)]),
           BL=('b1',(300,767),[(390,695),(340,695)]), BR=('b2',(725,767),[(635,695),(685,695)]))

def build(k):
    """按原带子中心线重建，可改尖端位置与两端宽度。返回多边形与末端角点映射。"""
    a1,a2,c1,c2=EDGES[k]; _,_,w=band_frame(k); d=unit(sub(a2,a1))
    # 中心线：两条边线中点连线
    p_from=mid(a1,c1); p_to=mid(a2,c2)
    # 端切线（水平：尖端；末端：原末端边方向）
    vcut=sub(*O[k]['v'][::-1]); ecut=sub(O[k]['e'][1],O[k]['e'][0])
    vy=O[k]['v'][0][1]
    # 中心线与两端切线的交点
    cvert=inter(p_from,d,(0,vy),(1,0)); cend=inter(p_from,d,mid(*O[k]['e']),unit(ecut))
    if VBY is not None and k in ('b3','b4'):
        # V 底尖上移：保持末端不动，中心线终点移到新的底部切线上
        cvert=(cvert[0]+(0 if True else 0), VBY)
        # 新方向
    if k in CL: cvert,cend=tuple(CL[k][0]),tuple(CL[k][1])
    cend=add(cvert,mul(sub(cend,cvert),ARM))
    dy=SH if k in ('b1','b2') else -SH
    cvert=(cvert[0],cvert[1]+dy); cend=(cend[0],cend[1]+dy)
    d2=unit(sub(cvert,cend)); n2=(-d2[1],d2[0])
    w_v=w*VS; w_e=w*ES
    # 两条边线：从末端（宽 w_e）到尖端（宽 w_v）
    L1a=add(cend,mul(n2,w_e/2)); L1b=add(cvert,mul(n2,w_v/2))
    L2a=add(cend,mul(n2,-w_e/2)); L2b=add(cvert,mul(n2,-w_v/2))
    e1=unit(sub(L1b,L1a)); e2=unit(sub(L2b,L2a))
    ec=(n2[0],n2[1]) if k in CL else unit(ecut)
    P1=inter(L1a,e1,cend,ec); P2=inter(L2a,e2,cend,ec)
    vline_y=cvert[1]
    Q1=inter(L1a,e1,(0,vline_y),(1,0)); Q2=inter(L2a,e2,(0,vline_y),(1,0))
    return [P1,Q1,Q2,P2], (P1,P2), d2, n2

geo={k:build(k) for k in O}
# Λ 两腿顶端、V 两臂底端在中线处会穿出：被上层带子盖住即可，不需要额外裁切
def barb(name):
    k,root,others=BARBS[name]; a1,a2,c1,c2=EDGES[k]; d,n,w=band_frame(k)
    poly,(P1,P2),d2,n2=geo[k]
    # 原根部角点对应的新角点：取离原根部更近的末端角点
    oldP=[O[k]['e'][0],O[k]['e'][1]]
    newroot=min((P1,P2),key=lambda p:math.hypot(*sub(p,root)))
    s=(ES)**0.5
    res=[newroot]
    for o in others:
        v=sub(o,root); lu=v[0]*d[0]+v[1]*d[1]; ln=v[0]*n[0]+v[1]*n[1]
        res.append(add(newroot,add(mul(d2,lu*s),mul(n2,ln*s))))
    return res
B={nm:barb(nm) for nm in BARBS}
def pts(p): return ' '.join(f'{x:.1f},{y:.1f}' for x,y in p)
def lg(i,a,b,c1,c2): return f'<linearGradient id="{i}" gradientUnits="userSpaceOnUse" x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient>'
b3,b4=geo['b3'][0],geo['b4'][0]
c3=mid(*geo['b3'][1]); c4=mid(*geo['b4'][1])
v3=mid(b3[1],b3[2]); v4=mid(b4[1],b4[2])
allp=[p for k in geo for p in geo[k][0]]+[p for b in B.values() for p in b]
FIT=A.get('fit')   # 目标外接框边长：自动居中缩放
if FIT:
    x0=min(p[0] for p in allp); x1=max(p[0] for p in allp); y0=min(p[1] for p in allp); y1=max(p[1] for p in allp)
    ZOOM=FIT/max(x1-x0,y1-y0); TX,TY=(x0+x1)/2,(y0+y1)/2
else: TX=TY=512
BARBS_SVG=f'''<polygon points="{pts(B['TL'])}" fill="url(#gb1)"/><polygon points="{pts(B['TR'])}" fill="url(#gb2)"/>
<polygon points="{pts(B['BL'])}" fill="url(#gb3)"/><polygon points="{pts(B['BR'])}" fill="url(#gb4)"/>
'''
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
{lg('g3',c3,add(c3,mul(sub(v3,c3),0.55)),'#548CE3','#2961CE')}
{lg('g4',c4,add(c4,mul(sub(v4,c4),0.75)),'#7CB1EC','#3575E0')}
{lg('gb1',B['TL'][0],B['TL'][1],'#12225A','#2552AA')}{lg('gb2',B['TR'][0],B['TR'][1],'#12225A','#2552AA')}
{lg('gb3',B['BL'][0],B['BL'][1],'#12225A','#244078')}{lg('gb4',B['BR'][0],B['BR'][1],'#12225A','#244078')}
<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
<clipPath id="under"><polygon points="{pts(geo['b2'][0])}"/><polygon points="{pts(geo['b3'][0])}"/></clipPath>
</defs>
{'' if A.get('transparent') else '<rect width="1024" height="1024" fill="#fff"/>'}
<g transform="translate(512 512) scale({ZOOM:.4f}) translate({-TX:.1f} {-TY:.1f})">
{'' if BARB_TOP else BARBS_SVG}<polygon points="{pts(geo['b2'][0])}" fill="#2961CE"/>
<polygon points="{pts(geo['b3'][0])}" fill="url(#g3)"/>
<g clip-path="url(#under)" opacity="0.5"><polygon points="{pts(geo['b1'][0])}" fill="#0A1A4A" filter="url(#blur)"/><polygon points="{pts(geo['b4'][0])}" fill="#0A1A4A" filter="url(#blur)"/></g>
<polygon points="{pts(geo['b1'][0])}" fill="#63A2F9"/>
<polygon points="{pts(geo['b4'][0])}" fill="url(#g4)"/>
{BARBS_SVG if BARB_TOP else ''}
</g></svg>'''
open(out,'w').write(svg)
