import {Component} from 'react';
/** A render failure leaves a recovery control instead of blanking the application. */
export class SectionBoundary extends Component {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidUpdate(previous){if(this.state.failed&&previous.resetKey!==this.props.resetKey)this.setState({failed:false});}
 render(){return this.state.failed?<section className="staff-error" role="alert"><p>No pudimos mostrar esta sección. Puedes volver a cargar sus datos sin cerrar tu sesión.</p><button type="button" className="staff-refresh" onClick={()=>{this.setState({failed:false});this.props.onRetry?.();}}>Reintentar sección</button></section>:this.props.children;}
}
